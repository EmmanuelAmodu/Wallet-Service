import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Prisma as SweepPrisma, SweepWalletRegistration } from '.prisma/sweep-client';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { MessageAuth, canonical } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { chainFamily } from '../../../../packages/shared/src/contracts.js';
import { sweepConfig } from '../config/sweep.config.js';
import { SweepPrismaService } from '../prisma/prisma.service.js';

type RegistryEvent = Extract<
  ExchangeEvent,
  { type: 'customer-wallet.registry.requested.v1' | 'custody-wallet.registry.requested.v1' }
>;
type DepositResult = Extract<
  ExchangeEvent,
  { type: 'deposit.credited.v1' | 'deposit.reversed.v1' }
>;

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// The scheduling projection deliberately has no signing or broadcasting dependency.
// Phase 4 must add policies, chain balance reads, and execution reservations before enabling it.
@Injectable()
export class SweepService {
  constructor(
    private readonly db: SweepPrismaService,
    private readonly auth: MessageAuth,
    @Inject(sweepConfig.KEY)
    private readonly config: Pick<ConfigType<typeof sweepConfig>, 'domainId'>,
  ) {}

  async handle(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    if (event.domainId !== this.config.domainId)
      throw new ActionRejectedError('Event belongs to a different exchange custody domain');
    await this.db.$transaction(async (tx) => {
      // Serializes local registry and work projection so late hot/customer deliveries cannot race credits.
      await lock(tx, `sweep-domain:${event.domainId}:${event.resetEpoch}`);
      await lock(tx, `sweep-inbox:${event.eventId}`);
      const previous = await tx.inbox.findUnique({ where: { id: event.eventId } });
      const payloadHash = digest(event);
      if (previous) {
        if (
          previous.payload_hash !== payloadHash ||
          previous.domain_id !== event.domainId ||
          previous.reset_epoch !== event.resetEpoch
        )
          throw new ActionRejectedError('Sweep event ID was reused with different content');
        return;
      }
      switch (event.type) {
        case 'customer-wallet.registry.requested.v1':
        case 'custody-wallet.registry.requested.v1':
          await this.register(tx, event);
          break;
        case 'deposit.credited.v1':
        case 'deposit.reversed.v1':
          await this.projectDeposit(tx, event);
          break;
        case 'deposit.deficit-recorded.v1':
        case 'custody.loss.recorded.v1':
        case 'custody.loss.reverted.v1':
          await this.pauseCustomer(
            tx,
            event,
            'reason' in event.data ? event.data.reason : event.type,
          );
          break;
        case 'custody.incident.opened.v1':
        case 'custody.incident.updated.v1':
          if (event.data.severity === 'high' || event.data.severity === 'critical') {
            if (event.customerId) await this.pauseCustomer(tx, event, event.data.reason);
            else await this.pauseDomain(tx, event, event.data.reason);
          }
          break;
        case 'custody.incident.resolved.v1':
          // Resolution does not silently clear a custody review gate.
          break;
        default:
          throw new ActionRejectedError(
            'Unsupported sweep event; only accounted deposits schedule work',
          );
      }
      await tx.inbox.create({
        data: {
          id: event.eventId,
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
          payload_hash: payloadHash,
        },
      });
    });
  }

  private async customer(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    customerId: string,
  ) {
    const prior = await tx.sweepCustomer.findUnique({ where: { customer_id: customerId } });
    if (prior && (prior.domain_id !== event.domainId || prior.reset_epoch !== event.resetEpoch))
      throw new ActionRejectedError('Sweep customer identity is immutable');
    return tx.sweepCustomer.upsert({
      where: { customer_id: customerId },
      create: { customer_id: customerId, domain_id: event.domainId, reset_epoch: event.resetEpoch },
      update: {},
    });
  }

  private async register(tx: SweepPrisma.TransactionClient, event: RegistryEvent) {
    const data = event.data;
    const customer = event.type === 'customer-wallet.registry.requested.v1';
    const identity = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      chain: data.chain,
      network: data.network,
      address: data.address,
      address_key:
        chainFamily(data.chain) === 'ethereum' ? data.address.toLowerCase() : data.address,
      role: customer ? 'customer' : event.data.role,
      account: data.account,
      customer_id: customer ? event.customerId : null,
      hot_wallet_id: customer ? event.data.hotWalletId : null,
    };
    const prior = await tx.sweepWalletRegistration.findUnique({
      where: { wallet_id: data.walletId },
    });
    if (prior) {
      for (const key of [
        'domain_id',
        'reset_epoch',
        'chain',
        'network',
        'address_key',
        'role',
        'account',
        'customer_id',
        'hot_wallet_id',
      ] as const)
        if (prior[key] !== identity[key])
          throw new ActionRejectedError('Published sweep wallet registry identity is immutable');
      if (data.registryRevision < prior.registry_revision) return;
    }
    if (customer) await this.customer(tx, event, event.customerId);
    await tx.sweepWalletRegistration.upsert({
      where: { wallet_id: data.walletId },
      create: { wallet_id: data.walletId, ...identity, registry_revision: data.registryRevision },
      update: { registry_revision: data.registryRevision },
    });
    const affected = await tx.sweepWork.findMany({
      where: {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        OR: [
          { source_wallet_id: data.walletId },
          { hot_wallet_id: data.walletId },
          { chain: data.chain, network: data.network, state: 'awaiting_hot_wallet' },
        ],
      },
    });
    for (const work of affected)
      await this.refreshWork(tx, event, work.source_wallet_id, work.customer_id, {
        chain: work.chain as CanonicalAsset['chain'],
        network: work.network,
        assetId: work.asset_id,
      });
  }

  private validateWallet(wallet: SweepWalletRegistration, event: DepositResult) {
    const asset = event.data.asset;
    if (
      wallet.domain_id !== event.domainId ||
      wallet.reset_epoch !== event.resetEpoch ||
      wallet.role !== 'customer' ||
      wallet.account < 10 ||
      wallet.customer_id !== event.customerId ||
      wallet.chain !== asset.chain ||
      wallet.network !== asset.network
    )
      throw new ActionRejectedError('Accounted deposit does not match its sweep source registry');
  }

  private async projectDeposit(tx: SweepPrisma.TransactionClient, event: DepositResult) {
    const asset = event.data.asset;
    const previous = await tx.sweepDeposit.findUnique({
      where: { deposit_id: event.data.depositId },
    });
    const credit = event.type === 'deposit.credited.v1';
    const walletId = credit ? event.data.walletId : (previous?.wallet_id ?? null);
    const identity = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      customer_id: event.customerId,
      chain: asset.chain,
      network: asset.network,
      asset_id: asset.assetId,
      amount: event.data.amount,
    };
    if (previous) {
      for (const key of Object.keys(identity) as (keyof typeof identity)[])
        if (previous[key] !== identity[key])
          throw new ActionRejectedError('Accounted sweep deposit identity changed');
      if (previous.wallet_id && credit && previous.wallet_id !== walletId)
        throw new ActionRejectedError('Accounted sweep deposit source changed');
    }
    const revisionDigest = digest({ ...identity, type: event.type, data: event.data });
    if (previous && event.revision <= previous.revision) {
      if (event.revision === previous.revision && revisionDigest !== previous.revision_digest)
        throw new ActionRejectedError('Accounted sweep deposit revision content changed');
      return;
    }
    await this.customer(tx, event, event.customerId);
    if (walletId) {
      const registry = await tx.sweepWalletRegistration.findUnique({
        where: { wallet_id: walletId },
      });
      if (registry) this.validateWallet(registry, event);
      const owner = await tx.sweepWork.findFirst({ where: { source_wallet_id: walletId } });
      if (owner && owner.customer_id !== event.customerId)
        throw new ActionRejectedError('Sweep source already belongs to a different customer');
    }
    await tx.sweepDeposit.upsert({
      where: { deposit_id: event.data.depositId },
      create: {
        deposit_id: event.data.depositId,
        ...identity,
        wallet_id: walletId,
        state: credit ? 'credited' : 'reversed',
        revision: event.revision,
        revision_digest: revisionDigest,
      },
      update: {
        wallet_id: walletId,
        state: credit ? 'credited' : 'reversed',
        revision: event.revision,
        revision_digest: revisionDigest,
      },
    });
    if (walletId) await this.refreshWork(tx, event, walletId, event.customerId, asset);
    if (event.type === 'deposit.reversed.v1' && event.data.deficitIncidentId)
      await this.pauseCustomer(tx, event, 'Deposit reversal left a customer deficit');
  }

  private async pauseDomain(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    reason: string,
  ) {
    // Domain review is represented durably even when no customers or work exist yet.
    await tx.sweepDomainGate.upsert({
      where: {
        domain_id_reset_epoch: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      },
      create: { domain_id: event.domainId, reset_epoch: event.resetEpoch, reason },
      update: {},
    });
    await tx.sweepWork.updateMany({
      where: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      data: { state: 'paused_review', reason },
    });
  }

  private async pauseCustomer(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    reason: string,
  ) {
    if (!event.customerId) throw new ActionRejectedError('Customer custody incident has no owner');
    await this.customer(tx, event, event.customerId);
    await tx.sweepCustomer.update({
      where: { customer_id: event.customerId },
      data: { paused: true, pause_reason: reason },
    });
    await tx.sweepWork.updateMany({
      where: {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        customer_id: event.customerId,
      },
      data: { state: 'paused_review', reason },
    });
  }

  private async refreshWork(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    walletId: string,
    customerId: string,
    asset: CanonicalAsset,
  ) {
    const where = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      source_wallet_id: walletId,
      chain: asset.chain,
      network: asset.network,
      asset_id: asset.assetId,
    };
    const deposits = await tx.sweepDeposit.findMany({
      where: { ...identityFields(where), wallet_id: walletId, state: 'credited' },
    });
    const observedCreditUnits = deposits
      .reduce((total, row) => total + BigInt(row.amount), 0n)
      .toString();
    const source = await tx.sweepWalletRegistration.findUnique({ where: { wallet_id: walletId } });
    const hot = source?.hot_wallet_id
      ? await tx.sweepWalletRegistration.findUnique({ where: { wallet_id: source.hot_wallet_id } })
      : null;
    const customer = await tx.sweepCustomer.findUniqueOrThrow({
      where: { customer_id: customerId },
    });
    const domainGate = await tx.sweepDomainGate.findUnique({
      where: {
        domain_id_reset_epoch: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      },
    });
    let state = 'blocked_execution_not_implemented';
    let reason = 'Phase 4 policy, chain balance, and execution reservation checks are required';
    const sourceMatches =
      source &&
      source.role === 'customer' &&
      source.account >= 10 &&
      source.customer_id === customerId &&
      source.domain_id === event.domainId &&
      source.reset_epoch === event.resetEpoch &&
      source.chain === asset.chain &&
      source.network === asset.network;
    const hotMatches =
      hot &&
      hot.role === 'hot' &&
      hot.account === 0 &&
      hot.domain_id === event.domainId &&
      hot.reset_epoch === event.resetEpoch &&
      hot.chain === asset.chain &&
      hot.network === asset.network;
    if (domainGate || customer.paused) {
      state = 'paused_review';
      reason = domainGate?.reason ?? customer.pause_reason ?? 'Custody review required';
    } else if (source && !sourceMatches) {
      state = 'paused_registry_identity';
      reason = 'Published source registry conflicts with accounted deposit identity';
    } else if (hot && !hotMatches) {
      state = 'paused_registry_identity';
      reason = 'Published hot wallet conflicts with source custody identity';
    } else if (!deposits.length) {
      state = 'no_credited_deposits';
      reason = 'All accounted deposits for this source and asset were reversed';
    } else if (
      asset.assetId !== `token:${asset.chain}:native` ||
      !['ethereum', 'bitcoin', 'solana'].includes(asset.chain)
    ) {
      state = 'deferred_unsupported_asset';
      reason = 'Initial sweeps support native Ethereum, Bitcoin, and Solana assets';
    } else if (!source) {
      state = 'awaiting_registry';
      reason = 'Awaiting durable source wallet registry delivery';
    } else if (!hot) {
      state = 'awaiting_hot_wallet';
      reason = 'Awaiting account 0 hot wallet registry delivery';
    }
    const data = {
      customer_id: customerId,
      hot_wallet_id: source?.hot_wallet_id ?? null,
      observed_credit_units: observedCreditUnits,
      credited_deposit_count: deposits.length,
      state,
      reason,
    };
    const previous = await tx.sweepWork.findUnique({
      where: { domain_id_reset_epoch_source_wallet_id_chain_network_asset_id: where },
    });
    if (previous && previous.customer_id !== customerId)
      throw new ActionRejectedError('Sweep work ownership changed');
    if (
      previous &&
      (Object.keys(data) as (keyof typeof data)[]).every((key) => previous[key] === data[key])
    )
      return;
    await tx.sweepWork.upsert({
      where: { domain_id_reset_epoch_source_wallet_id_chain_network_asset_id: where },
      create: { ...where, ...data },
      update: { ...data, revision: { increment: 1 } },
    });
  }
}

function identityFields(work: {
  domain_id: string;
  reset_epoch: string;
  chain: string;
  network: string;
  asset_id: string;
}) {
  return {
    domain_id: work.domain_id,
    reset_epoch: work.reset_epoch,
    chain: work.chain,
    network: work.network,
    asset_id: work.asset_id,
  };
}
