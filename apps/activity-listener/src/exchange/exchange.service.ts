import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ExchangeWalletRegistration, ExchangeTransfer, Prisma } from '.prisma/activity-client';
import { ActivityPrismaService } from '../prisma/prisma.service.js';
import { ActivityRegistryService } from '../registry/registry.service.js';
import {
  ExchangeVerifier,
  VerifiedExchangeTransaction,
  VerifiedExchangeTransfer,
} from '../../../../packages/chain/src/exchange-verifier.js';
import {
  ExchangeDiscoverySignal,
  exchangeDiscoverySchema,
} from '../../../../packages/shared/src/exchange-discovery.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { MessageAuth, canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue, enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { isEvmChain, canonicalTransactionHash } from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  exchangeObservationConfig,
  ExchangeObservationSettings,
} from '../config/exchange-observation.config.js';

type Intent = Extract<
  ExchangeEvent,
  {
    type:
      | 'sweep.execute.requested.v1'
      | 'funding.execute.requested.v1'
      | 'withdrawal.execute.requested.v1';
  }
>;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;
const addressKey = (chain: string, address: string) =>
  isEvmChain(chain as never) ? address.toLowerCase() : address;

// The same transfer has the same ID across retries, backfill, and provider message IDs.
function stableUuid(key: unknown) {
  const hex = digest(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

@Injectable()
export class ActivityExchangeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityExchangeService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: ActivityPrismaService,
    private readonly verifier: ExchangeVerifier,
    private readonly auth: MessageAuth,
    private readonly registry: ActivityRegistryService,
    @Inject(exchangeObservationConfig.KEY)
    private readonly config: Pick<
      ExchangeObservationSettings,
      'pollMs' | 'reconciliationMs' | 'recoveryMs'
    >,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.tick(), this.config.recoveryMs);
    this.tick();
  }

  private tick() {
    if (!this.running)
      this.running = this.recover()
        .catch(() =>
          this.logger.warn('Exchange observation recovery deferred; durable work retained'),
        )
        .finally(() => {
          this.running = undefined;
        });
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async recover(limit = 50) {
    await this.registry.recoverPending(limit);
    const rows = await this.db.exchangeDiscovery.findMany({
      where: { reset_epoch: this.auth.resetEpoch, next_check_at: { lte: new Date() } },
      orderBy: { next_check_at: 'asc' },
      take: limit,
    });
    for (const row of rows) {
      try {
        await this.check(row.id);
      } catch {
        /* A retained due row is retried after the next scan. */
      }
    }
  }

  async receive(input: ExchangeDiscoverySignal) {
    const signal = exchangeDiscoverySchema.parse(input);
    if (signal.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale discovery epoch');
    const id = digest([signal.resetEpoch, signal.chain, signal.network, signal.transactionHash]);
    await this.db.$transaction(async (tx) => {
      const inboxId = `exchange-discovery:${signal.resetEpoch}:${signal.discoveryId}`;
      await lock(tx, inboxId);
      const seen = await tx.inbox.findUnique({ where: { id: inboxId } });
      const hash = digest(signal);
      if (seen && seen.payload_hash !== hash)
        throw new ActionRejectedError('Discovery ID reused with different content');
      if (!seen) {
        await tx.exchangeDiscovery.upsert({
          where: { id },
          create: {
            id,
            reset_epoch: signal.resetEpoch,
            chain: signal.chain,
            network: signal.network,
            transaction_hash: signal.transactionHash,
            payload_hash: hash,
            signal: json(signal),
          },
          update: { next_check_at: new Date(), signal: json(signal) },
        });
        await tx.inbox.create({ data: { id: inboxId, payload_hash: hash } });
      }
    });
    await this.check(id);
  }

  async check(id: string) {
    // Increment before RPC: a delayed response from an older concurrent check cannot overwrite a newer check.
    const ticket = await this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-discovery-check:${id}`);
      const row = await tx.exchangeDiscovery.findUniqueOrThrow({ where: { id } });
      if (row.reset_epoch !== this.auth.resetEpoch)
        throw new ActionRejectedError('Stale discovery epoch');
      if (row.lease_until && row.lease_until > new Date()) return null;
      const leaseUntil = new Date(Date.now() + 120000);
      return tx.exchangeDiscovery.update({
        where: { id },
        data: {
          check_revision: { increment: 1 },
          lease_until: leaseUntil,
          next_check_at: leaseUntil,
        },
      });
    });
    if (!ticket) return;
    const signal = exchangeDiscoverySchema.parse(ticket.signal);
    let verified: VerifiedExchangeTransaction;
    let priorInclusionOrphaned = false;
    try {
      verified = await this.verifier.verify(signal);
      if (
        verified.chain !== signal.chain ||
        verified.network !== signal.network ||
        verified.transactionHash !== signal.transactionHash
      )
        throw new ActionRejectedError('Verified transaction identity mismatch');
      if (
        verified.state === 'pending' &&
        ticket.finalized_block_hash &&
        ticket.finalized_block_height &&
        verified.blockHash !== ticket.finalized_block_hash
      ) {
        const canonicalBlock = await this.verifier.isCanonicalBlock(
          signal.chain,
          signal.network,
          ticket.finalized_block_height,
          ticket.finalized_block_hash,
        );
        priorInclusionOrphaned = canonicalBlock === false;
      }
    } catch (error) {
      await this.db.exchangeDiscovery.updateMany({
        where: { id, check_revision: ticket.check_revision },
        data: {
          last_error: 'Canonical RPC verification unavailable; discovery retained',
          lease_until: null,
          next_check_at: new Date(Date.now() + this.config.pollMs),
        },
      });
      throw error;
    }
    await this.db
      .$transaction(async (tx) => {
        await lock(tx, `exchange-discovery-check:${id}`);
        const current = await tx.exchangeDiscovery.findUniqueOrThrow({ where: { id } });
        if (current.check_revision !== ticket.check_revision) return;
        let rows = await tx.exchangeWalletRegistration.findMany({
          where: { chain: signal.chain, network: signal.network, reset_epoch: signal.resetEpoch },
        });
        for (const walletId of rows.map((row) => row.wallet_id).sort())
          await lock(tx, `registry:${walletId}`);
        rows = await tx.exchangeWalletRegistration.findMany({
          where: { chain: signal.chain, network: signal.network, reset_epoch: signal.resetEpoch },
        });
        const addresses = new Set<string>();
        for (const row of rows) {
          if (addresses.has(row.address))
            throw new ActionRejectedError('Custody address ownership is ambiguous across domains');
          addresses.add(row.address);
        }
        const hint = signal.walletId
          ? rows.find((row) => row.wallet_id === signal.walletId)
          : undefined;
        if (
          signal.walletId &&
          (!hint || (signal.registryRevision && hint.registry_revision < signal.registryRevision))
        ) {
          await tx.exchangeDiscovery.update({
            where: { id },
            data: {
              state: 'awaiting_registry',
              last_error: 'Registry identity or revision is unavailable',
              lease_until: null,
              next_check_at: new Date(Date.now() + this.config.pollMs),
            },
          });
          return;
        }
        const customers = rows.filter((row) => row.role === 'customer_deposit');
        const relevant = customers.filter(
          (row) =>
            verified.transfers.some((transfer) =>
              [transfer.from, transfer.to].some(
                (address) => address && addressKey(signal.chain, address) === row.address,
              ),
            ) ||
            verified.spentAddresses?.includes(row.address) ||
            (verified.fee?.payer && addressKey(signal.chain, verified.fee.payer) === row.address) ||
            row.wallet_id === signal.walletId,
        );
        const prior = await tx.exchangeTransfer.findMany({
          where: {
            reset_epoch: signal.resetEpoch,
            chain: signal.chain,
            network: signal.network,
            transaction_hash: signal.transactionHash,
          },
        });
        const affected = new Set([
          ...relevant.map((row) => row.wallet_id),
          ...prior.map((row) => row.wallet_id),
        ]);
        const custodyReady = (row: ExchangeWalletRegistration) =>
          rows.some(
            (hot) =>
              hot.wallet_id === row.hot_wallet_id &&
              hot.domain_id === row.domain_id &&
              hot.role === 'hot' &&
              hot.account === 0 &&
              hot.status === 'ready',
          ) &&
          (signal.chain === 'bitcoin' ||
            rows.some(
              (management) =>
                management.domain_id === row.domain_id &&
                management.role === 'management' &&
                management.account === 1 &&
                management.status === 'ready',
            ));
        if (
          customers.some(
            (row) =>
              affected.has(row.wallet_id) &&
              (row.status !== 'ready' || !row.backfill_complete || !custodyReady(row)),
          )
        ) {
          await tx.exchangeDiscovery.update({
            where: { id },
            data: {
              state: 'awaiting_registry',
              last_error: 'Provider coverage paused; replay retained',
              lease_until: null,
              next_check_at: new Date(Date.now() + this.config.pollMs),
            },
          });
          return;
        }
        for (const domainId of [...new Set(rows.map((row) => row.domain_id))].sort())
          await lock(tx, `activity-domain:${domainId}`);
        if (priorInclusionOrphaned) {
          // Compensation and the replacement observation commit together. A pending replacement
          // never inherits a credit or custody loss belonging to a disproven finalized inclusion.
          for (const transfer of prior)
            await this.revertTransfer(
              tx,
              transfer,
              'Prior finalized inclusion is no longer canonical',
            );
          await this.revertLosses(tx, signal);
        }
        if (verified.state === 'reverted' || verified.state === 'failed') {
          for (const transfer of prior)
            await this.revertTransfer(
              tx,
              transfer,
              'Canonical transaction is no longer a successful included transfer',
            );
          if (verified.state === 'reverted') await this.revertLosses(tx, signal);
          if (verified.state === 'failed')
            for (const source of relevant)
              await this.inspectOutflow(tx, source, rows, signal, verified);
        } else {
          const owned = new Map(rows.map((row) => [row.address, row]));
          const bitcoinOwnedSpend = (verified.spentAddresses ?? []).some((address) =>
            owned.has(addressKey(signal.chain, address)),
          );
          const ownedOrigin =
            bitcoinOwnedSpend ||
            (verified.fee?.payer && owned.has(addressKey(signal.chain, verified.fee.payer))) ||
            verified.transfers.some(
              (transfer) => transfer.from && owned.has(addressKey(signal.chain, transfer.from)),
            );
          const verifiedKeys = new Set<string>();
          for (const transfer of verified.transfers) {
            const destination = owned.get(addressKey(signal.chain, transfer.to));
            if (!destination || destination.role !== 'customer_deposit') continue;
            const senderOwned =
              ownedOrigin ||
              (transfer.from
                ? owned.has(addressKey(signal.chain, transfer.from))
                : bitcoinOwnedSpend);
            if (senderOwned) continue; // Owned movements are custody, never an external customer credit.
            if (transfer.asset.assetId !== `token:${signal.chain}:native`) {
              await this.incident(
                tx,
                destination,
                signal,
                'unsupported_asset',
                'Asset discovery is outside the native launch scope',
                transfer,
              );
              continue;
            }
            const key = canonical(transfer.identity);
            verifiedKeys.add(`${destination.wallet_id}:${key}`);
            if (
              signal.chain === 'solana' &&
              verified.state === 'finalized' &&
              transfer.destinationOwnerProgram !== '11111111111111111111111111111111'
            ) {
              const transferId = stableUuid([
                signal.resetEpoch,
                destination.domain_id,
                signal.chain,
                signal.network,
                signal.transactionHash,
                transfer.asset.assetId,
                key,
              ]);
              const credited = await tx.exchangeTransfer.findUnique({ where: { id: transferId } });
              if (transfer.destinationOwnerProgram || credited?.state !== 'finalized')
                await this.incident(
                  tx,
                  destination,
                  signal,
                  'unspendable_native_account',
                  transfer.destinationOwnerProgram
                    ? 'Native Solana recipient is owned by another program; withdrawals frozen pending custody review'
                    : 'Native Solana recipient ownership is unavailable; deposit credit deferred',
                  transfer,
                );
              continue;
            }
            if (verified.state === 'finalized' && !verified.transfersComplete) {
              await this.incident(
                tx,
                destination,
                signal,
                'incomplete_native_observation',
                'Transaction native movements are incomplete; deposit credit deferred until certified verification',
                { blockHash: verified.blockHash },
              );
              continue;
            }
            await this.applyTransfer(tx, destination, signal, verified, transfer);
          }
          // A changed canonical receipt can remove an old transfer even if the transaction remains included.
          if (verified.state === 'finalized' && verified.transfersComplete)
            for (const old of prior) {
              if (!verifiedKeys.has(`${old.wallet_id}:${old.transfer_key}`))
                await this.revertTransfer(
                  tx,
                  old,
                  'Transfer absent from the canonical transaction',
                );
            }
          if (verified.state === 'finalized')
            for (const source of relevant) {
              if (verified.transfersComplete)
                await this.inspectOutflow(tx, source, rows, signal, verified);
              else if (
                verified.spentAddresses?.includes(source.address) ||
                (verified.fee?.payer &&
                  addressKey(signal.chain, verified.fee.payer) === source.address) ||
                verified.transfers.some(
                  (transfer) =>
                    transfer.from && addressKey(signal.chain, transfer.from) === source.address,
                )
              )
                await this.incident(
                  tx,
                  source,
                  signal,
                  'incomplete_customer_outflow',
                  'Customer wallet participated in an incompletely decoded transaction; frozen for custody review without estimating a net loss',
                  { blockHash: verified.blockHash },
                );
            }
        }
        await tx.exchangeDiscovery.update({
          where: { id },
          data: {
            state: verified.state,
            last_error: null,
            lease_until: null,
            ...(verified.blockHash
              ? { block_hash: verified.blockHash, block_height: verified.blockHeight }
              : {}),
            ...((verified.state === 'finalized' || verified.state === 'failed') &&
            verified.blockHash &&
            verified.blockHeight
              ? {
                  finalized_block_hash: verified.blockHash,
                  finalized_block_height: verified.blockHeight,
                }
              : verified.state === 'reverted' || priorInclusionOrphaned
                ? { finalized_block_hash: null, finalized_block_height: null }
                : {}),
            next_check_at: new Date(
              Date.now() +
                (verified.state === 'pending' ? this.config.pollMs : this.config.reconciliationMs),
            ),
          },
        });
        await enqueue(
          tx,
          QUEUES.activity,
          { type: 'exchange.discovery.check', discoveryId: id },
          `exchange-check:${id}:${ticket.check_revision}`,
          verified.state === 'pending' ? this.config.pollMs : this.config.reconciliationMs,
        );
      })
      .catch(async (error) => {
        await this.db.exchangeDiscovery.updateMany({
          where: { id, check_revision: ticket.check_revision },
          data: {
            lease_until: null,
            next_check_at: new Date(Date.now() + this.config.pollMs),
            last_error: 'Observation needs registry or financial reconciliation',
          },
        });
        throw error;
      });
  }

  private envelope(row: ExchangeWalletRegistration | ExchangeTransfer, revision: number) {
    return {
      eventId: randomUUID(),
      schemaVersion: 1,
      resetEpoch: row.reset_epoch,
      occurredAt: new Date().toISOString(),
      domainId: row.domain_id,
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: row.wallet_id,
      revision,
      ...(row.customer_id ? { customerId: row.customer_id } : {}),
    };
  }

  private async applyTransfer(
    tx: Prisma.TransactionClient,
    wallet: ExchangeWalletRegistration,
    signal: ExchangeDiscoverySignal,
    verified: VerifiedExchangeTransaction,
    transfer: VerifiedExchangeTransfer,
  ) {
    const transferKey = canonical(transfer.identity);
    const id = stableUuid([
      signal.resetEpoch,
      wallet.domain_id,
      signal.chain,
      signal.network,
      signal.transactionHash,
      transfer.asset.assetId,
      transferKey,
    ]);
    const old = await tx.exchangeTransfer.findUnique({ where: { id } });
    const state = verified.state === 'finalized' ? 'finalized' : 'pending';
    // Below-finality or incomplete-history observations cannot alter an accepted credit.
    // check() compensates a positively orphaned inclusion before reaching this method.
    if (old?.state === 'finalized' && state === 'pending') return;
    if (
      old &&
      (old.wallet_id !== wallet.wallet_id ||
        old.customer_id !== wallet.customer_id ||
        old.amount !== transfer.amount ||
        old.from_address !== transfer.from ||
        old.to_address !== transfer.to)
    ) {
      await this.revertTransfer(
        tx,
        old,
        'Canonical transfer value or counterparty changed after a reorg',
      );
      await this.incident(
        tx,
        wallet,
        signal,
        'canonical_transfer_identity_conflict',
        'Canonical transfer identity changed; customer frozen for operator reconciliation',
        transfer,
      );
      return;
    }
    if (old?.state === state && (state !== 'finalized' || old.block_hash === verified.blockHash))
      return;
    const latest = await tx.exchangeTransfer.findUnique({ where: { id } });
    const revision = (latest?.revision ?? 0) + 1;
    await tx.exchangeTransfer.upsert({
      where: { id },
      create: {
        id,
        domain_id: wallet.domain_id,
        reset_epoch: signal.resetEpoch,
        customer_id: wallet.customer_id!,
        wallet_id: wallet.wallet_id,
        chain: signal.chain,
        network: signal.network,
        asset_id: transfer.asset.assetId,
        transaction_hash: signal.transactionHash,
        transfer_key: transferKey,
        identity: json(transfer.identity),
        from_address: transfer.from,
        to_address: transfer.to,
        amount: transfer.amount,
        state,
        revision,
        block_hash: verified.blockHash,
        block_height: verified.blockHeight,
      },
      update: {
        state,
        revision,
        block_hash: verified.blockHash,
        block_height: verified.blockHeight,
      },
    });
    const event = exchangeEventSchema.parse({
      ...this.envelope(wallet, revision),
      aggregateId: id,
      type: state === 'finalized' ? 'deposit.finalized.v1' : 'deposit.observed.v1',
      data: {
        depositId: id,
        walletId: wallet.wallet_id,
        asset: transfer.asset,
        transferIdentity: transfer.identity,
        transactionHash: signal.transactionHash,
        amount: transfer.amount,
        ...(state === 'finalized'
          ? { blockHash: verified.blockHash, blockHeight: verified.blockHeight }
          : {}),
      },
    });
    await enqueueFanOut(tx, event, [QUEUES.ledger, QUEUES.wallet]);
  }

  private async revertTransfer(
    tx: Prisma.TransactionClient,
    transfer: ExchangeTransfer,
    reason: string,
  ) {
    // Earlier compensation in this transaction may already have advanced this row.
    transfer = await tx.exchangeTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    if (transfer.state === 'reverted') return;
    const revision = transfer.revision + 1;
    await tx.exchangeTransfer.update({
      where: { id: transfer.id },
      data: { state: 'reverted', revision },
    });
    const event = exchangeEventSchema.parse({
      ...this.envelope(transfer, revision),
      aggregateId: transfer.id,
      type: 'deposit.reverted.v1',
      data: {
        depositId: transfer.id,
        asset: { chain: transfer.chain, network: transfer.network, assetId: transfer.asset_id },
        transferIdentity: transfer.identity,
        transactionHash: transfer.transaction_hash,
        reason,
      },
    });
    await enqueueFanOut(tx, event, [QUEUES.ledger, QUEUES.wallet]);
  }

  async observeOperation(event: ExchangeEvent) {
    if (
      ![
        'sweep.execute.requested.v1',
        'funding.execute.requested.v1',
        'withdrawal.execute.requested.v1',
        'execution.attempt.updated.v1',
      ].includes(event.type)
    )
      throw new ActionRejectedError('Unsupported operation projection');
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale operation epoch');
    await this.db.$transaction(async (tx) => {
      await lock(tx, `activity-operation:${event.operationId}`);
      const inboxId = `activity-operation-event:${event.eventId}`,
        hash = digest(event);
      const seen = await tx.inbox.findUnique({ where: { id: inboxId } });
      if (seen) {
        if (seen.payload_hash !== hash)
          throw new ActionRejectedError('Operation event content changed');
        return;
      }
      const existing = await tx.exchangeObservedOperation.findUnique({
        where: { operation_id: event.operationId! },
      });
      if (
        existing &&
        (existing.domain_id !== event.domainId ||
          existing.reset_epoch !== event.resetEpoch ||
          existing.request_digest !== event.requestDigest ||
          existing.attempt_id !== event.attemptId)
      )
        throw new ActionRejectedError('Operation projection identity changed');
      if (event.type === 'execution.attempt.updated.v1') {
        if (!existing) throw new Error('Execution intent projection has not arrived');
        if (event.revision > existing.attempt_revision) {
          if (
            existing.transaction_hash &&
            event.data.transactionHash &&
            existing.transaction_hash !==
              canonicalTransactionHash(
                (existing.intent as unknown as Intent).data.amount.asset.chain,
                event.data.transactionHash,
              )
          )
            throw new ActionRejectedError('Attempt transaction hash is immutable');
          const intent = existing.intent as unknown as Intent;
          await tx.exchangeObservedOperation.update({
            where: { operation_id: event.operationId },
            data: {
              attempt_revision: event.revision,
              state: event.data.state,
              ...(event.data.transactionHash
                ? {
                    transaction_hash: canonicalTransactionHash(
                      intent.data.amount.asset.chain,
                      event.data.transactionHash,
                    ),
                  }
                : {}),
            },
          });
          if (event.data.transactionHash) {
            const discoveries = await tx.exchangeDiscovery.findMany({
              where: {
                reset_epoch: event.resetEpoch,
                chain: intent.data.amount.asset.chain,
                network: intent.data.amount.asset.network,
                transaction_hash: canonicalTransactionHash(
                  intent.data.amount.asset.chain,
                  event.data.transactionHash,
                ),
              },
            });
            for (const discovery of discoveries) {
              await tx.exchangeDiscovery.update({
                where: { id: discovery.id },
                data: { next_check_at: new Date() },
              });
              await enqueue(
                tx,
                QUEUES.activity,
                { type: 'exchange.discovery.check', discoveryId: discovery.id },
                `operation-recheck:${event.eventId}:${discovery.id}`,
              );
            }
          }
        }
      } else {
        const intent = event as Intent;
        if (existing && canonical(existing.intent) !== canonical(intent))
          throw new ActionRejectedError('Operation intent is immutable');
        if (!existing)
          await tx.exchangeObservedOperation.create({
            data: {
              operation_id: intent.operationId,
              domain_id: intent.domainId,
              reset_epoch: intent.resetEpoch,
              attempt_id: intent.attemptId,
              request_digest: intent.requestDigest,
              kind: intent.type,
              intent: json(intent),
              revision: intent.revision,
            },
          });
      }
      await tx.inbox.create({ data: { id: inboxId, payload_hash: hash } });
    });
  }

  private async authorisedSweep(
    tx: Prisma.TransactionClient,
    source: ExchangeWalletRegistration,
    rows: ExchangeWalletRegistration[],
    signal: ExchangeDiscoverySignal,
    verified: VerifiedExchangeTransaction,
  ) {
    const operations = await tx.exchangeObservedOperation.findMany({
      where: {
        domain_id: source.domain_id,
        reset_epoch: signal.resetEpoch,
        transaction_hash: signal.transactionHash,
        kind: 'sweep.execute.requested.v1',
        state: { in: ['signed', 'queued', 'submitted', 'confirmed', 'attention'] },
      },
    });
    for (const operation of operations) {
      const intent = operation.intent as unknown as Extract<
        Intent,
        { type: 'sweep.execute.requested.v1' }
      >;
      const hot = rows.find(
        (row) =>
          row.wallet_id === source.hot_wallet_id &&
          row.role === 'hot' &&
          row.account === 0 &&
          row.domain_id === source.domain_id,
      );
      if (
        !hot ||
        intent.data.sourceWalletId !== source.wallet_id ||
        intent.data.destinationWalletId !== hot.wallet_id
      )
        continue;
      const asset = intent.data.amount.asset;
      if (
        asset.chain !== signal.chain ||
        asset.network !== signal.network ||
        asset.assetId !== `token:${signal.chain}:native`
      )
        continue;
      const transfers = verified.transfers.filter(
        (transfer) =>
          transfer.asset.assetId === asset.assetId &&
          (signal.chain === 'bitcoin' ||
            addressKey(signal.chain, transfer.from ?? '') === source.address),
      );
      if (verified.state !== 'failed') {
        if (
          !transfers.length ||
          transfers.some((transfer) => addressKey(signal.chain, transfer.to) !== hot.address)
        )
          continue;
        if (
          signal.chain === 'bitcoin' &&
          ((verified.spentAddresses ?? []).length === 0 ||
            (verified.spentAddresses ?? []).some((address) => address !== source.address))
        )
          continue;
        if (
          transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n) !==
          BigInt(intent.data.amount.amount)
        )
          continue;
      }
      const cap =
        signal.chain === 'bitcoin'
          ? 10000n
          : signal.chain === 'solana'
            ? 100000n
            : 5000000000000000n;
      if (
        !verified.fee ||
        verified.fee.asset.chain !== signal.chain ||
        verified.fee.asset.network !== signal.network ||
        verified.fee.asset.assetId !== `token:${signal.chain}:native`
      )
        continue;
      if (
        signal.chain !== 'bitcoin' &&
        (!verified.fee.payer || addressKey(signal.chain, verified.fee.payer) !== source.address)
      )
        continue;
      return { operation, feeCap: cap, feeCapExceeded: BigInt(verified.fee.amount) > cap };
    }
    return undefined;
  }

  private async inspectOutflow(
    tx: Prisma.TransactionClient,
    source: ExchangeWalletRegistration,
    rows: ExchangeWalletRegistration[],
    signal: ExchangeDiscoverySignal,
    verified: VerifiedExchangeTransaction,
  ) {
    const olderLosses = await tx.exchangeCustodyIncident.findMany({
      where: {
        reset_epoch: signal.resetEpoch,
        wallet_id: source.wallet_id,
        transaction_hash: signal.transactionHash,
        category: 'unexpected_customer_outflow',
        state: 'open',
      },
    });
    if (
      verified.blockHash &&
      olderLosses.some(
        (loss) => (loss.evidence as { blockHash?: string }).blockHash !== verified.blockHash,
      )
    )
      await this.revertLosses(
        tx,
        signal,
        source.wallet_id,
        'Prior loss inclusion replaced by a different canonical block; custody loss re-evaluated',
      );
    const outgoing = verified.transfers
      .filter(
        (transfer) =>
          transfer.asset.assetId === `token:${signal.chain}:native` &&
          addressKey(signal.chain, transfer.from ?? '') === source.address,
      )
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);
    const returned = verified.transfers
      .filter(
        (transfer) =>
          transfer.asset.assetId === `token:${signal.chain}:native` &&
          addressKey(signal.chain, transfer.to) === source.address,
      )
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);
    let loss = outgoing - returned;
    const paidBySource =
      verified.fee?.payer && addressKey(signal.chain, verified.fee.payer) === source.address;
    if (paidBySource) loss += BigInt(verified.fee!.amount);
    if (signal.chain === 'bitcoin') {
      const spent = (verified.spentInputs ?? [])
        .filter((input) => input.address === source.address)
        .reduce((sum, input) => sum + BigInt(input.amount), 0n);
      const returned = verified.transfers
        .filter((transfer) => transfer.to === source.address)
        .reduce((sum, t) => sum + BigInt(t.amount), 0n);
      loss = spent > returned ? spent - returned : 0n;
    }
    for (const transfer of verified.transfers.filter(
      (transfer) =>
        transfer.asset.assetId !== `token:${signal.chain}:native` &&
        addressKey(signal.chain, transfer.from ?? '') === source.address,
    ))
      await this.incident(
        tx,
        source,
        signal,
        'unsupported_asset_outflow',
        'Unsupported asset left a customer deposit wallet; custody exception requires review',
        transfer,
      );
    if (loss <= 0n) return;
    const sweep = await this.authorisedSweep(tx, source, rows, signal, verified);
    if (sweep) {
      await this.revertLosses(
        tx,
        signal,
        source.wallet_id,
        'Confirmed authorization identifies a custody sweep; provisional loss compensated',
      );
      if (sweep.feeCapExceeded)
        await this.incident(
          tx,
          source,
          signal,
          'sweep_fee_policy_breach',
          'Matching custody sweep exceeds exchange-financial-v1 network fee cap; actual principal and fee remain owned by operation settlement',
          {
            operationId: sweep.operation.operation_id,
            attemptId: sweep.operation.attempt_id,
            requestDigest: sweep.operation.request_digest,
            policyVersion: 'exchange-financial-v1',
            transactionHash: signal.transactionHash,
            blockHash: verified.blockHash,
            fee: verified.fee,
            feeCap: sweep.feeCap.toString(),
          },
        );
      return;
    }
    await this.incident(
      tx,
      source,
      signal,
      'unexpected_customer_outflow',
      'Customer deposit wallet spent outside a persisted matching hot sweep',
      {
        amount: loss.toString(),
        blockHash: verified.blockHash,
        asset: {
          chain: signal.chain,
          network: signal.network,
          assetId: `token:${signal.chain}:native`,
        },
      },
    );
  }

  private async incident(
    tx: Prisma.TransactionClient,
    wallet: ExchangeWalletRegistration,
    signal: ExchangeDiscoverySignal,
    category: string,
    reason: string,
    evidence: unknown,
  ) {
    const key = digest([
      signal.resetEpoch,
      wallet.domain_id,
      wallet.wallet_id,
      signal.transactionHash,
      category,
      category.startsWith('unsupported_asset')
        ? evidence
        : category === 'unexpected_customer_outflow'
          ? (evidence as { blockHash?: string }).blockHash
          : category === 'unspendable_native_account'
            ? ((evidence as VerifiedExchangeTransfer).destinationOwnerProgram ?? null)
            : null,
    ]);
    const old = await tx.exchangeCustodyIncident.findUnique({ where: { incident_key: key } });
    if (old && old.state === 'open') return;
    const id = old?.id ?? stableUuid(key),
      revision = (old?.revision ?? 0) + 1;
    await tx.exchangeCustodyIncident.upsert({
      where: { incident_key: key },
      create: {
        id,
        incident_key: key,
        domain_id: wallet.domain_id,
        reset_epoch: signal.resetEpoch,
        customer_id: wallet.customer_id,
        wallet_id: wallet.wallet_id,
        chain: signal.chain,
        network: signal.network,
        transaction_hash: signal.transactionHash,
        category,
        reason,
        evidence: json(evidence),
        revision,
      },
      update: { state: 'open', revision },
    });
    const loss = evidence as { amount?: string; asset?: unknown };
    const event = exchangeEventSchema.parse({
      ...this.envelope(wallet, revision),
      aggregateId: id,
      type:
        category === 'unexpected_customer_outflow'
          ? 'custody.loss.detected.v1'
          : 'custody.incident.opened.v1',
      data:
        category === 'unexpected_customer_outflow'
          ? {
              incidentId: id,
              walletId: wallet.wallet_id,
              asset: loss.asset,
              amount: loss.amount,
              transactionHash: signal.transactionHash,
              reason,
            }
          : {
              incidentId: id,
              severity:
                category === 'canonical_transfer_identity_conflict'
                  ? 'critical'
                  : category === 'incomplete_customer_outflow' ||
                      category === 'sweep_fee_policy_breach' ||
                      (category === 'unspendable_native_account' &&
                        (evidence as VerifiedExchangeTransfer).destinationOwnerProgram)
                    ? 'high'
                    : 'low',
              category,
              status: 'open',
              reason,
            },
    });
    await enqueueFanOut(tx, event, [QUEUES.ledger]);
  }

  private async revertLosses(
    tx: Prisma.TransactionClient,
    signal: ExchangeDiscoverySignal,
    walletId?: string,
    reason = 'Unexpected outflow block is no longer canonical; customer remains frozen for review',
  ) {
    const losses = await tx.exchangeCustodyIncident.findMany({
      where: {
        reset_epoch: signal.resetEpoch,
        chain: signal.chain,
        network: signal.network,
        transaction_hash: signal.transactionHash,
        category: 'unexpected_customer_outflow',
        state: 'open',
        ...(walletId ? { wallet_id: walletId } : {}),
      },
    });
    for (const loss of losses) {
      const wallet = await tx.exchangeWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: loss.wallet_id },
      });
      const evidence = loss.evidence as { amount: string; asset: unknown };
      const revision = loss.revision + 1;
      await tx.exchangeCustodyIncident.update({
        where: { id: loss.id },
        data: { state: 'reverted', revision },
      });
      await enqueueFanOut(
        tx,
        exchangeEventSchema.parse({
          ...this.envelope(wallet, revision),
          aggregateId: loss.id,
          type: 'custody.loss.reverted.v1',
          data: {
            incidentId: loss.id,
            walletId: loss.wallet_id,
            asset: evidence.asset,
            amount: evidence.amount,
            transactionHash: signal.transactionHash,
            reason,
          },
        }),
        [QUEUES.ledger],
      );
    }
  }
}
