import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Deposit, Prisma as LedgerPrisma } from '.prisma/ledger-client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { queueConfig, QueueConfig } from '../../../../packages/queue/src/queue.config.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { canonicalTransactionHash } from '../../../../packages/shared/src/contracts.js';
import { AccountSpec } from '../accounts/accounts.service.js';
import { JournalPosting, JournalService } from '../journal/journal.service.js';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import {
  consumeExchangeEvent,
  exchangeDigest,
  publishExchangeEvent,
} from '../exchange/exchange-inbox.js';

type DepositEvent = Extract<
  ExchangeEvent,
  {
    type: 'deposit.observed.v1' | 'deposit.finalized.v1' | 'deposit.reverted.v1';
  }
>;

function assetIdentity(event: DepositEvent) {
  return event.data.asset;
}

function eventIdentity(event: DepositEvent) {
  return {
    domainId: event.domainId,
    customerId: event.customerId,
    asset: assetIdentity(event),
    transactionHash: canonicalTransactionHash(event.data.asset.chain, event.data.transactionHash),
    transferIdentity: event.data.transferIdentity,
  };
}

function sameRevisionContent(event: DepositEvent) {
  return exchangeDigest({
    ...eventIdentity(event),
    type: event.type,
    revision: event.revision,
    data: event.data,
  });
}

@Injectable()
export class DepositsService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly journal: JournalService,
    @Inject(queueConfig.KEY) private readonly config: Pick<QueueConfig, 'resetEpoch'>,
  ) {}

  async handle(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (
      !['deposit.observed.v1', 'deposit.finalized.v1', 'deposit.reverted.v1'].includes(event.type)
    )
      throw new ActionRejectedError('Unsupported deposit event');
    if (event.resetEpoch !== this.config.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    await this.db.$transaction(async (tx) =>
      consumeExchangeEvent(tx, event, async () => {
        await lock(tx, `exchange-domain:${event.domainId}`);
        await this.apply(tx, event as DepositEvent);
      }),
    );
  }

  private account(event: DepositEvent, type: AccountSpec['type'], ownerId: string): AccountSpec {
    return {
      domainId: event.domainId,
      ...assetIdentity(event),
      type,
      ownerKind: type === 'custody_deposit' ? 'wallet' : 'customer',
      ownerId,
      normalSide: ['custody_deposit', 'deficit'].includes(type) ? 'debit' : 'credit',
    };
  }

  private async apply(tx: LedgerPrisma.TransactionClient, event: DepositEvent) {
    const asset = assetIdentity(event);
    const identity = eventIdentity(event);
    const transferId = JSON.stringify([
      identity.transactionHash,
      event.data.transferIdentity.kind,
      event.data.transferIdentity.id,
    ]);
    const customer = await tx.exchangeCustomer.findUnique({
      where: { customer_id: event.customerId },
    });
    if (!customer)
      throw new Error('Deposit customer is not registered yet; awaiting registry delivery');
    if (customer.domain_id !== event.domainId)
      throw new ActionRejectedError('Deposit customer is not registered in this custody domain');
    const existing = await tx.deposit.findUnique({ where: { id: event.data.depositId } });
    const sameTransfer = await tx.deposit.findUnique({
      where: {
        domain_id_chain_network_asset_id_transfer_id: {
          domain_id: event.domainId,
          chain: asset.chain,
          network: asset.network,
          asset_id: asset.assetId,
          transfer_id: transferId,
        },
      },
    });
    if (sameTransfer && sameTransfer.id !== event.data.depositId)
      throw new ActionRejectedError('Deposit transfer already belongs to a different deposit ID');
    if (
      existing &&
      (existing.domain_id !== event.domainId ||
        existing.customer_id !== event.customerId ||
        existing.chain !== asset.chain ||
        existing.network !== asset.network ||
        existing.asset_id !== asset.assetId ||
        existing.transfer_id !== transferId ||
        existing.reset_epoch !== event.resetEpoch)
    )
      throw new ActionRejectedError('Deposit identity changed');
    let walletId = existing?.wallet_id;
    let amount = existing?.amount?.toFixed(0);
    let immutableDigest = existing?.identity_digest;
    if (event.type !== 'deposit.reverted.v1') {
      const wallet = await tx.exchangeWallet.findUnique({
        where: { wallet_id: event.data.walletId },
      });
      if (!wallet) throw new Error('Deposit wallet registry has not arrived yet');
      if (
        !wallet ||
        wallet.role !== 'customer' ||
        wallet.domain_id !== event.domainId ||
        wallet.customer_id !== event.customerId ||
        wallet.chain !== asset.chain ||
        wallet.network !== asset.network ||
        wallet.reset_epoch !== event.resetEpoch
      )
        throw new ActionRejectedError('Deposit wallet registry identity is invalid');
      const digest = exchangeDigest({
        ...identity,
        walletId: event.data.walletId,
        amount: event.data.amount,
      });
      if (immutableDigest && immutableDigest !== digest)
        throw new ActionRejectedError('Deposit amount or wallet identity changed');
      walletId = wallet.wallet_id;
      amount = event.data.amount;
      immutableDigest = digest;
    }
    if (existing && event.revision <= existing.revision) {
      if (
        event.revision === existing.revision &&
        sameRevisionContent(existing.payload as unknown as DepositEvent) !==
          sameRevisionContent(event)
      )
        throw new ActionRejectedError('Deposit revision was reused with different content');
      return;
    }
    const state: Deposit['state'] =
      event.type === 'deposit.reverted.v1'
        ? 'reverted'
        : event.type === 'deposit.finalized.v1'
          ? 'finalized'
          : existing?.state === 'finalized' || existing?.state === 'reverted'
            ? existing.state
            : 'pending';
    const data = {
      domain_id: event.domainId,
      customer_id: event.customerId,
      wallet_id: walletId,
      chain: asset.chain,
      network: asset.network,
      asset_id: asset.assetId,
      transfer_id: transferId,
      transfer_identity: event.data.transferIdentity,
      transaction_hash: identity.transactionHash,
      amount: amount ? new Prisma.Decimal(amount) : undefined,
      identity_digest: immutableDigest,
      state,
      revision: event.revision,
      payload: event as unknown as LedgerPrisma.InputJsonValue,
      reset_epoch: event.resetEpoch,
      ...(event.type === 'deposit.finalized.v1' ? { block_hash: event.data.blockHash } : {}),
    };
    const deposit = existing
      ? await tx.deposit.update({ where: { id: existing.id }, data })
      : await tx.deposit.create({ data: { id: event.data.depositId, ...data } });
    if (event.type === 'deposit.finalized.v1' && existing?.state !== 'finalized') {
      const value = BigInt(amount!);
      const deficitAccount = this.account(event, 'deficit', event.customerId);
      const deficit =
        customer.state === 'frozen' ? await this.journal.balance(tx, deficitAccount) : 0n;
      const recovery = deficit < value ? deficit : value;
      const postings: JournalPosting[] = [
        {
          account: this.account(event, 'custody_deposit', walletId!),
          side: 'debit',
          amount: value,
        },
      ];
      if (recovery > 0n)
        postings.push({ account: deficitAccount, side: 'credit', amount: recovery });
      if (value > recovery)
        postings.push({
          account: this.account(
            event,
            customer.state === 'frozen' ? 'customer_frozen' : 'customer_available',
            event.customerId,
          ),
          side: 'credit',
          amount: value - recovery,
        });
      const batch = await this.journal.post(tx, {
        key: `deposit:${deposit.id}:credit:${event.revision}`,
        domainId: event.domainId,
        revision: event.revision,
        kind: 'deposit.credit',
        postings,
      });
      await tx.deposit.update({ where: { id: deposit.id }, data: { credit_batch_id: batch.id } });
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'deposit.credited.v1',
          data: {
            depositId: deposit.id,
            ledgerBatchId: batch.id,
            walletId: walletId!,
            asset,
            amount: amount!,
          },
        },
        `deposit:${deposit.id}:credited:${event.revision}`,
      );
    } else if (event.type === 'deposit.reverted.v1' && existing?.state === 'finalized') {
      await this.reverse(tx, event, deposit, existing, amount!, walletId!);
    }
  }

  private async reverse(
    tx: LedgerPrisma.TransactionClient,
    event: Extract<DepositEvent, { type: 'deposit.reverted.v1' }>,
    deposit: Deposit,
    previous: Deposit,
    amountString: string,
    walletId: string,
  ) {
    const amount = BigInt(amountString);
    const available = this.account(event, 'customer_available', event.customerId);
    const frozen = this.account(event, 'customer_frozen', event.customerId);
    const availableBalance = await this.journal.balance(tx, available);
    const frozenBalance = await this.journal.balance(tx, frozen);
    const fromAvailable = availableBalance < amount ? availableBalance : amount;
    const remaining = amount - fromAvailable;
    const fromFrozen = frozenBalance < remaining ? frozenBalance : remaining;
    const deficit = remaining - fromFrozen;
    const postings = [
      {
        account: this.account(event, 'custody_deposit', walletId),
        side: 'credit' as const,
        amount,
      },
      ...(fromAvailable > 0n
        ? [{ account: available, side: 'debit' as const, amount: fromAvailable }]
        : []),
      ...(fromFrozen > 0n ? [{ account: frozen, side: 'debit' as const, amount: fromFrozen }] : []),
      ...(deficit > 0n
        ? [
            {
              account: this.account(event, 'deficit', event.customerId),
              side: 'debit' as const,
              amount: deficit,
            },
          ]
        : []),
    ];
    let incidentId: string | undefined;
    if (deficit > 0n) {
      incidentId = randomUUID();
      await tx.exchangeCustomer.update({
        where: { customer_id: event.customerId },
        data: { state: 'frozen' },
      });
      const availableAccounts = await tx.ledgerAccount.findMany({
        where: {
          domain_id: event.domainId,
          owner_kind: 'customer',
          owner_id: event.customerId,
          type: 'customer_available',
        },
      });
      for (const row of availableAccounts) {
        const source: AccountSpec = {
          domainId: row.domain_id,
          chain: row.chain,
          network: row.network,
          assetId: row.asset_id,
          type: 'customer_available',
          ownerKind: 'customer',
          ownerId: event.customerId,
          normalSide: 'credit',
        };
        const before = await this.journal.balance(tx, source);
        const residual =
          before -
          (row.chain === available.chain &&
          row.network === available.network &&
          row.asset_id === available.assetId
            ? fromAvailable
            : 0n);
        if (residual <= 0n) continue;
        postings.push(
          { account: source, side: 'debit', amount: residual },
          { account: { ...source, type: 'customer_frozen' }, side: 'credit', amount: residual },
        );
      }
      await tx.ledgerIncident.create({
        data: {
          id: incidentId,
          domain_id: event.domainId,
          customer_id: event.customerId,
          deposit_id: deposit.id,
          reason: event.data.reason,
          state: 'open',
          amount: { asset: assetIdentity(event), amount: deficit.toString() },
        },
      });
    }
    const batch = await this.journal.post(tx, {
      key: `deposit:${deposit.id}:reverse:${event.revision}`,
      domainId: event.domainId,
      revision: event.revision,
      kind: 'deposit.reversal',
      reversalOfBatchId: previous.credit_batch_id ?? undefined,
      postings,
    });
    await tx.deposit.update({ where: { id: deposit.id }, data: { reversal_batch_id: batch.id } });
    await publishExchangeEvent(
      tx,
      event,
      {
        type: 'deposit.reversed.v1',
        data: {
          depositId: deposit.id,
          ledgerBatchId: batch.id,
          asset: assetIdentity(event),
          amount: amountString,
          reason: event.data.reason,
          ...(incidentId ? { deficitIncidentId: incidentId } : {}),
        },
      },
      `deposit:${deposit.id}:reversed:${event.revision}`,
    );
    if (incidentId) {
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'deposit.deficit-recorded.v1',
          data: {
            depositId: deposit.id,
            incidentId,
            asset: assetIdentity(event),
            amount: deficit.toString(),
            reason: event.data.reason,
          },
        },
        `deposit:${deposit.id}:deficit:${event.revision}`,
      );
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'custody.incident.opened.v1',
          data: {
            incidentId,
            severity: 'critical',
            category: 'deposit_reorg_deficit',
            status: 'open',
            reason: event.data.reason,
          },
        },
        `deposit:${deposit.id}:incident:${event.revision}`,
      );
    }
  }
}
