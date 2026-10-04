import { Injectable } from '@nestjs/common';
import type { ExchangeOperation, ExchangeWallet, Prisma } from '.prisma/ledger-client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  canonicalTransactionHash,
  chainFamily,
} from '../../../../packages/shared/src/contracts.js';
import { AccountSpec, accountNormalSides } from '../accounts/accounts.service.js';
import { JournalPosting, JournalService } from '../journal/journal.service.js';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { consumeExchangeEvent, exchangeDigest } from '../exchange/exchange-inbox.js';
import { resultIdentity } from '../exchange/events.js';

type ExecuteEvent = Extract<
  ExchangeEvent,
  {
    type:
      | 'sweep.execute.requested.v1'
      | 'funding.execute.requested.v1'
      | 'withdrawal.execute.requested.v1';
  }
>;
type SettlementEvent = Extract<ExchangeEvent, { type: 'settlement.requested.v1' }>;
type RevertEvent = Extract<ExchangeEvent, { type: 'settlement.reverted.v1' }>;

function assetKey(asset: CanonicalAsset) {
  return canonical([asset.chain, asset.network, asset.assetId]);
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly journal: JournalService,
    private readonly reservations: ReservationsService,
  ) {}

  async handle(event: ExchangeEvent) {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-domain:${event.domainId}`);
      await consumeExchangeEvent(tx, event, async () => {
        if (
          event.type === 'sweep.execute.requested.v1' ||
          event.type === 'funding.execute.requested.v1' ||
          event.type === 'withdrawal.execute.requested.v1'
        )
          await this.recordExecution(tx, event);
        else if (event.type === 'execution.attempt.updated.v1') await this.updateAttempt(tx, event);
        else if (event.type === 'settlement.requested.v1') await this.settle(tx, event);
        else if (event.type === 'settlement.reverted.v1') await this.revert(tx, event);
        else throw new ActionRejectedError('Unsupported settlement event');
      });
    });
  }

  private account(
    domainId: string,
    asset: CanonicalAsset,
    type: AccountSpec['type'],
    ownerId: string,
  ): AccountSpec {
    return {
      domainId,
      ...asset,
      type,
      ownerId,
      ownerKind:
        type.startsWith('customer_') || type === 'deficit'
          ? 'customer'
          : type.startsWith('custody_')
            ? 'wallet'
            : 'exchange',
      normalSide: accountNormalSides[type],
    };
  }

  private custody(domainId: string, asset: CanonicalAsset, wallet: ExchangeWallet) {
    const type =
      wallet.role === 'hot'
        ? 'custody_hot'
        : wallet.role === 'management'
          ? 'custody_management'
          : 'custody_deposit';
    return this.account(domainId, asset, type, wallet.wallet_id);
  }

  private async wallet(
    tx: Prisma.TransactionClient,
    id: string,
    event: ExchangeEvent,
    asset: CanonicalAsset,
  ) {
    const wallet = await tx.exchangeWallet.findUnique({ where: { wallet_id: id } });
    if (
      !wallet ||
      wallet.domain_id !== event.domainId ||
      wallet.reset_epoch !== event.resetEpoch ||
      wallet.chain !== asset.chain ||
      wallet.network !== asset.network
    )
      throw new ActionRejectedError(
        'Execution wallet does not match custody domain, epoch and asset network',
      );
    return wallet;
  }

  private async recordExecution(tx: Prisma.TransactionClient, event: ExecuteEvent) {
    const existing = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (existing) {
      const original = exchangeEventSchema.parse(existing.payload) as ExecuteEvent;
      if (
        existing.domain_id !== event.domainId ||
        existing.reset_epoch !== event.resetEpoch ||
        existing.request_digest !== event.requestDigest ||
        existing.attempt_id !== event.attemptId ||
        canonical(original.data) !== canonical(event.data) ||
        original.customerId !== event.customerId
      )
        throw new ActionRejectedError(
          'Execution operation identity and approved request are immutable',
        );
      return;
    }
    const source = await this.wallet(tx, event.data.sourceWalletId, event, event.data.amount.asset);
    let reservationId: string | undefined;
    let customerId = event.customerId;
    if (event.type === 'withdrawal.execute.requested.v1') {
      if (source.role !== 'hot')
        throw new ActionRejectedError('Withdrawals execute only from hot custody');
      const reservation = await tx.withdrawalReservation.findUnique({
        where: { operation_id: event.operationId },
      });
      if (!reservation) throw new Error('Withdrawal reservation has not arrived');
      if (
        reservation.domain_id !== event.domainId ||
        reservation.request_digest !== event.requestDigest ||
        reservation.reset_epoch !== event.resetEpoch ||
        reservation.state !== 'held'
      )
        throw new ActionRejectedError('Withdrawal requires its active immutable reservation');
      const request = exchangeEventSchema.parse(
        (reservation.request as { source?: unknown }).source,
      );
      if (
        request.type !== 'withdrawal.reserve.requested.v1' ||
        request.data.hotWalletId !== source.wallet_id ||
        request.data.destination !== event.data.destination ||
        assetKey(request.data.principal.asset) !== assetKey(event.data.amount.asset) ||
        request.data.principal.amount !== event.data.amount.amount ||
        (event.customerId && event.customerId !== reservation.customer_id)
      )
        throw new ActionRejectedError(
          'Withdrawal execution differs from the accepted principal, destination or hot wallet',
        );
      const customer = await tx.exchangeCustomer.findUniqueOrThrow({
        where: { customer_id: reservation.customer_id },
      });
      if (customer.state !== 'active')
        throw new ActionRejectedError('Frozen customer cannot start execution');
      const ownDestination = await tx.exchangeWallet.findFirst({
        where: {
          domain_id: event.domainId,
          chain: source.chain,
          network: source.network,
          address_key:
            chainFamily(request.data.principal.asset.chain) === 'ethereum'
              ? event.data.destination.toLowerCase()
              : event.data.destination,
        },
      });
      if (ownDestination)
        throw new ActionRejectedError(
          'Exchange-owned withdrawal destinations require an internal transfer flow',
        );
      reservationId = reservation.id;
      customerId = reservation.customer_id;
    } else {
      const destination = await this.wallet(
        tx,
        event.data.destinationWalletId,
        event,
        event.data.amount.asset,
      );
      if (
        event.type === 'sweep.execute.requested.v1' &&
        (source.role !== 'customer' ||
          destination.role !== 'hot' ||
          source.hot_wallet_id !== destination.wallet_id)
      )
        throw new ActionRejectedError(
          'Sweep must move customer custody to its registered hot wallet',
        );
      if (
        event.type === 'funding.execute.requested.v1' &&
        (source.role !== 'management' || destination.role !== 'customer')
      )
        throw new ActionRejectedError(
          'Funding must move management custody to registered customer custody',
        );
    }
    await tx.exchangeOperation.create({
      data: {
        id: event.operationId,
        domain_id: event.domainId,
        customer_id: customerId,
        reservation_id: reservationId,
        request_digest: event.requestDigest,
        kind:
          event.type === 'withdrawal.execute.requested.v1'
            ? 'withdrawal'
            : event.type === 'sweep.execute.requested.v1'
              ? 'sweep'
              : 'funding',
        payload: event as Prisma.InputJsonValue,
        attempt_id: event.attemptId,
        attempt_revision: 0,
        state: 'preparing',
        reset_epoch: event.resetEpoch,
      },
    });
  }

  private async operation(
    tx: Prisma.TransactionClient,
    event: ExchangeEvent & { operationId: string; attemptId: string; requestDigest: string },
  ): Promise<ExchangeOperation> {
    const operation = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (!operation) throw new Error('Execution intent has not arrived; retain and retry the event');
    if (
      operation.domain_id !== event.domainId ||
      operation.reset_epoch !== event.resetEpoch ||
      operation.attempt_id !== event.attemptId ||
      operation.request_digest !== event.requestDigest
    )
      throw new ActionRejectedError('Execution attempt identity mismatch');
    return operation;
  }

  private async updateAttempt(
    tx: Prisma.TransactionClient,
    event: Extract<ExchangeEvent, { type: 'execution.attempt.updated.v1' }>,
  ) {
    const operation = await this.operation(tx, event);
    if (event.revision < operation.attempt_revision) return;
    if (event.revision === operation.attempt_revision) {
      if (event.data.state !== operation.state)
        throw new ActionRejectedError('Attempt revision conflicts with recorded state');
      return;
    }
    if (operation.settlement_batch_id || operation.state === 'reverted') return;
    if (operation.reservation_id) {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id },
      });
      if (!['held', 'frozen'].includes(reservation.state))
        throw new ActionRejectedError('Attempt cannot expose a released reservation');
    }
    const ranks: Record<string, number> = {
      preparing: 0,
      signing: 1,
      signed: 2,
      queued: 3,
      submitted: 4,
      attention: 4,
      confirmed: 5,
      failed: 5,
    };
    if (event.data.state !== 'attention' && ranks[event.data.state] < (ranks[operation.state] ?? 0))
      throw new ActionRejectedError('Attempt state cannot regress');
    await tx.exchangeOperation.update({
      where: { id: operation.id },
      data: { state: event.data.state, attempt_revision: event.revision },
    });
  }

  private async settle(tx: Prisma.TransactionClient, event: SettlementEvent) {
    const operation = await this.operation(tx, event);
    if (event.revision < operation.settlement_revision) return;
    const execution = exchangeEventSchema.parse(operation.payload) as ExecuteEvent;
    const source = await this.wallet(
      tx,
      execution.data.sourceWalletId,
      event,
      execution.data.amount.asset,
    );
    const hash = canonicalTransactionHash(
      execution.data.amount.asset.chain,
      event.data.transactionHash,
    );
    const identity = canonical([event.domainId, source.chain, source.network, hash]);
    const digest = exchangeDigest({
      identity,
      outcome: event.data.outcome,
      actualFees: event.data.actualFees,
    });
    if (operation.settlement_batch_id && operation.state !== 'reverted') {
      if (operation.settlement_identity !== identity || operation.settlement_digest !== digest)
        throw new ActionRejectedError(
          'Settled attempt cannot change transaction, outcome or actual fees',
        );
      return;
    }
    if (event.revision <= operation.settlement_revision)
      throw new ActionRejectedError('Canonical settlement requires a new revision after reversal');
    if (operation.settlement_identity && operation.settlement_identity !== identity)
      throw new ActionRejectedError('An immutable attempt cannot settle a different transaction');
    const duplicate = await tx.exchangeOperation.findUnique({
      where: { settlement_identity: identity },
    });
    if (duplicate && duplicate.id !== operation.id)
      throw new ActionRejectedError('Transaction already belongs to another operation');
    if (event.data.outcome === 'failed' && !event.data.actualFees.length)
      throw new ActionRejectedError(
        'A failed on-chain settlement requires evidence of paid network fees',
      );
    const postings: JournalPosting[] = [];
    if (operation.kind === 'withdrawal') {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id! },
      });
      if (!['held', 'frozen'].includes(reservation.state))
        throw new ActionRejectedError('Settlement requires an outstanding customer obligation');
      const request = exchangeEventSchema.parse(
        (reservation.request as { source?: unknown }).source,
      );
      if (request.type !== 'withdrawal.reserve.requested.v1')
        throw new ActionRejectedError('Invalid accepted withdrawal request');
      if (event.data.outcome === 'confirmed') {
        for (const amount of request.data.amounts)
          postings.push({
            account: this.account(
              event.domainId,
              amount.asset,
              'customer_reserved',
              reservation.customer_id,
            ),
            side: 'debit',
            amount: BigInt(amount.amount),
          });
        postings.push({
          account: this.custody(event.domainId, request.data.principal.asset, source),
          side: 'credit',
          amount: BigInt(request.data.principal.amount),
        });
        if (request.data.customerFee)
          postings.push({
            account: this.account(
              event.domainId,
              request.data.customerFee.asset,
              'fee_revenue',
              event.domainId,
            ),
            side: 'credit',
            amount: BigInt(request.data.customerFee.amount),
          });
      } else postings.push(...(await this.reservations.releasePostings(tx, reservation)));
      await tx.withdrawalReservation.update({
        where: { id: reservation.id },
        data: { state: 'settled' },
      });
    } else if (event.data.outcome === 'confirmed') {
      if (execution.type === 'withdrawal.execute.requested.v1')
        throw new ActionRejectedError('Custody operation identity mismatch');
      const destination = await this.wallet(
        tx,
        execution.data.destinationWalletId,
        event,
        execution.data.amount.asset,
      );
      const amount = BigInt(execution.data.amount.amount);
      postings.push(
        {
          account: this.custody(event.domainId, execution.data.amount.asset, source),
          side: 'credit',
          amount,
        },
        {
          account: this.custody(event.domainId, execution.data.amount.asset, destination),
          side: 'debit',
          amount,
        },
      );
    }
    for (const fee of event.data.actualFees) {
      if (
        fee.asset.chain !== source.chain ||
        fee.asset.network !== source.network ||
        fee.asset.assetId !== `token:${source.chain}:native`
      )
        throw new ActionRejectedError(
          'Actual transaction fee must use the source network native asset',
        );
      postings.push(
        {
          account: this.account(event.domainId, fee.asset, 'fee_expense', event.domainId),
          side: 'debit',
          amount: BigInt(fee.amount),
        },
        {
          account: this.custody(event.domainId, fee.asset, source),
          side: 'credit',
          amount: BigInt(fee.amount),
        },
      );
    }
    const batch = await this.journal.post(tx, {
      key: `settlement:${operation.id}:${event.revision}`,
      domainId: event.domainId,
      operationId: operation.id,
      revision: event.revision,
      kind: 'settlement',
      postings,
    });
    await tx.exchangeOperation.update({
      where: { id: operation.id },
      data: {
        state: event.data.outcome,
        settlement_revision: event.revision,
        settlement_batch_id: batch.id,
        settlement_payload: event as Prisma.InputJsonValue,
        settlement_identity: identity,
        settlement_digest: digest,
        settlement_outcome: event.data.outcome,
      },
    });
    const feeCap =
      source.chain === 'ethereum' && source.network === '11155111'
        ? 5000000000000000n
        : source.chain === 'bitcoin' && source.network === 'regtest'
          ? 10000n
          : source.chain === 'solana' &&
              ['devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'].includes(source.network)
            ? 100000n
            : undefined;
    const actualFee = event.data.actualFees.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
    if (feeCap !== undefined && actualFee > feeCap)
      await this.incident(
        tx,
        event,
        'Actual network cost exceeds exchange-financial-v1; cost recorded and execution requires policy review',
      );
    const custodyPostings = new Map(
      postings
        .filter((posting) => posting.account.type.startsWith('custody_'))
        .map((posting) => [canonical(posting.account), posting]),
    );
    for (const posting of custodyPostings.values()) {
      if ((await this.journal.balance(tx, posting.account)) < 0n)
        await this.incident(
          tx,
          event,
          'Canonical settlement exceeds observed custody; reconcile and fund the shortfall',
        );
    }
    await enqueue(
      tx,
      QUEUES.wallet,
      {
        ...resultIdentity(event),
        operationId: event.operationId,
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        type: 'settlement.committed.v1',
        data: { ledgerBatchId: batch.id, transactionHash: hash },
      },
      `settlement-result:${operation.id}:${event.revision}`,
    );
  }

  private async revert(tx: Prisma.TransactionClient, event: RevertEvent) {
    const operation = await this.operation(tx, event);
    if (event.revision < operation.settlement_revision) return;
    if (operation.state === 'reverted') {
      if (event.revision <= operation.settlement_revision) return;
      throw new ActionRejectedError('Settlement is already reversed');
    }
    if (
      !operation.settlement_batch_id ||
      event.data.priorSettlementRevision !== operation.settlement_revision ||
      event.revision <= operation.settlement_revision
    )
      throw new ActionRejectedError('Reversal must identify the current settled revision');
    const original = await tx.ledgerEntry.findMany({
      where: { batch_id: operation.settlement_batch_id },
      include: { account: true },
      orderBy: { sequence: 'asc' },
    });
    const postings: JournalPosting[] = [];
    let deficit = false;
    for (const entry of original) {
      const account = entry.account!;
      const spec: AccountSpec = {
        domainId: account.domain_id,
        chain: account.chain,
        network: account.network,
        assetId: account.asset_id,
        type: account.type,
        ownerKind: account.owner_kind,
        ownerId: account.owner_id,
        normalSide: account.normal_side,
      };
      const amount = BigInt(entry.amount.toFixed(0));
      const side = entry.side === 'credit' ? 'debit' : 'credit';
      if (side === 'debit' && ['customer_available', 'customer_frozen'].includes(account.type)) {
        const balance = await this.journal.balance(tx, spec);
        const usable = balance < amount ? balance : amount;
        if (usable > 0n) postings.push({ account: spec, side, amount: usable });
        if (usable < amount) {
          deficit = true;
          postings.push({
            account: this.account(
              event.domainId,
              {
                chain: account.chain as CanonicalAsset['chain'],
                network: account.network,
                assetId: account.asset_id,
              },
              'deficit',
              account.owner_id,
            ),
            side,
            amount: amount - usable,
          });
        }
      } else postings.push({ account: spec, side, amount });
    }
    const batch = await this.journal.post(tx, {
      key: `settlement-reversal:${operation.id}:${event.revision}`,
      domainId: event.domainId,
      operationId: operation.id,
      revision: event.revision,
      kind: 'settlement_reversal',
      postings,
      reversalOfBatchId: operation.settlement_batch_id,
    });
    if (operation.reservation_id) {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id },
      });
      await tx.withdrawalReservation.update({
        where: { id: reservation.id },
        data: { state: deficit ? 'frozen' : 'held' },
      });
      if (deficit)
        await tx.exchangeCustomer.update({
          where: { customer_id: reservation.customer_id },
          data: { state: 'frozen' },
        });
      if (deficit) {
        const availableAccounts = await tx.ledgerAccount.findMany({
          where: {
            domain_id: event.domainId,
            owner_kind: 'customer',
            owner_id: reservation.customer_id,
            type: 'customer_available',
          },
        });
        const freeze: JournalPosting[] = [];
        for (const account of availableAccounts) {
          const asset: CanonicalAsset = {
            chain: account.chain as CanonicalAsset['chain'],
            network: account.network,
            assetId: account.asset_id,
          };
          const available = this.account(
            event.domainId,
            asset,
            'customer_available',
            reservation.customer_id,
          );
          const amount = await this.journal.balance(tx, available);
          if (amount > 0n)
            freeze.push(
              { account: available, side: 'debit', amount },
              {
                account: this.account(
                  event.domainId,
                  asset,
                  'customer_frozen',
                  reservation.customer_id,
                ),
                side: 'credit',
                amount,
              },
            );
        }
        if (freeze.length)
          await this.journal.post(tx, {
            key: `settlement-reorg-freeze:${operation.id}:${event.revision}`,
            domainId: event.domainId,
            operationId: operation.id,
            revision: event.revision,
            kind: 'customer.freeze',
            postings: freeze,
          });
      }
    }
    await tx.exchangeOperation.update({
      where: { id: operation.id },
      data: { state: 'reverted', settlement_revision: event.revision },
    });
    await this.incident(
      tx,
      event,
      deficit
        ? 'Reorg restored an obligation after released funds were spent; customer frozen'
        : event.data.reason,
    );
    await enqueue(
      tx,
      QUEUES.wallet,
      {
        ...resultIdentity(event),
        operationId: event.operationId,
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        type: 'settlement.reversed.v1',
        data: {
          ledgerBatchId: batch.id,
          priorSettlementRevision: event.data.priorSettlementRevision,
          ...(operation.reservation_id ? { reservationId: operation.reservation_id } : {}),
        },
      },
      `settlement-reorg:${operation.id}:${event.revision}`,
    );
  }

  private async incident(tx: Prisma.TransactionClient, event: ExchangeEvent, reason: string) {
    const id = randomUUID();
    await tx.ledgerIncident.create({
      data: {
        id,
        domain_id: event.domainId,
        operation_id: event.operationId,
        customer_id: event.customerId,
        reason,
        state: 'open',
      },
    });
    await enqueue(
      tx,
      QUEUES.wallet,
      {
        ...resultIdentity(event),
        type: 'custody.incident.opened.v1',
        data: {
          incidentId: id,
          severity: 'critical',
          category: 'custody-reconciliation',
          status: 'open',
          reason,
        },
      },
      `incident:${id}`,
    );
  }
}
