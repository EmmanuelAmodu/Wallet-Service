import { Inject, Injectable } from '@nestjs/common';
import type { Prisma as LedgerPrisma, WithdrawalReservation } from '.prisma/ledger-client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { queueConfig, QueueConfig } from '../../../../packages/queue/src/queue.config.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { AccountSpec } from '../accounts/accounts.service.js';
import { JournalPosting, JournalService } from '../journal/journal.service.js';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import {
  consumeExchangeEvent,
  exchangeDigest,
  publishExchangeEvent,
} from '../exchange/exchange-inbox.js';

type ReserveEvent = Extract<ExchangeEvent, { type: 'withdrawal.reserve.requested.v1' }>;
type ReleaseEvent = Extract<ExchangeEvent, { type: 'reservation.release.requested.v1' }>;
type Amount = ReserveEvent['data']['amounts'][number];

function canonicalAmounts(amounts: Amount[]) {
  const grouped = new Map<string, Amount>();
  for (const amount of amounts) {
    const asset = amount.asset;
    const key = JSON.stringify([asset.chain, asset.network, asset.assetId]);
    grouped.set(key, {
      asset,
      amount: (BigInt(grouped.get(key)?.amount ?? '0') + BigInt(amount.amount)).toString(),
    });
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, amount]) => amount);
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly journal: JournalService,
    @Inject(queueConfig.KEY) private readonly config: Pick<QueueConfig, 'resetEpoch'>,
  ) {}

  async handle(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (
      event.type !== 'withdrawal.reserve.requested.v1' &&
      event.type !== 'reservation.release.requested.v1'
    )
      throw new ActionRejectedError('Unsupported reservation event');
    if (event.resetEpoch !== this.config.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    await this.db.$transaction(async (tx) =>
      consumeExchangeEvent(tx, event, async () => {
        await lock(tx, `exchange-domain:${event.domainId}`);
        if (event.type === 'withdrawal.reserve.requested.v1') await this.reserve(tx, event);
        else await this.release(tx, event);
      }),
    );
  }

  private account(
    event: ReserveEvent | ReleaseEvent,
    amount: Amount,
    type: AccountSpec['type'],
  ): AccountSpec {
    return {
      domainId: event.domainId,
      ...amount.asset,
      type,
      ownerKind: 'customer',
      ownerId: event.customerId,
      normalSide: type === 'deficit' ? 'debit' : 'credit',
    };
  }

  private async result(
    tx: LedgerPrisma.TransactionClient,
    event: ReserveEvent,
    reservation: WithdrawalReservation,
    redelivery = '',
  ) {
    if (reservation.state === 'rejected') {
      const rejected = reservation.request as unknown as {
        rejection: { code: string; reason: string };
      };
      await publishExchangeEvent(
        tx,
        event,
        { type: 'withdrawal.reserve.rejected.v1', data: rejected.rejection },
        `reservation:${reservation.id}:rejected${redelivery}`,
      );
    } else {
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'withdrawal.reserved.v1',
          data: {
            reservationId: reservation.id,
            ledgerBatchId: reservation.reserve_batch_id!,
          },
        },
        `reservation:${reservation.id}:reserved${redelivery}`,
      );
    }
  }

  private async reserve(tx: LedgerPrisma.TransactionClient, event: ReserveEvent) {
    const amounts = canonicalAmounts(event.data.amounts);
    const immutable = {
      domainId: event.domainId,
      customerId: event.customerId,
      requestDigest: event.requestDigest,
      policyVersion: event.policyVersion,
      data: { ...event.data, amounts },
    };
    const previous = await tx.withdrawalReservation.findUnique({
      where: { operation_id: event.operationId },
    });
    if (previous) {
      const saved = previous.request as unknown as { identity: unknown };
      if (
        previous.reset_epoch !== event.resetEpoch ||
        exchangeDigest(saved.identity) !== exchangeDigest(immutable)
      )
        throw new ActionRejectedError('Withdrawal operation was reused with a different request');
      // A logical operation's original hold/rejection is immutable even after expiry or release.
      await this.result(tx, event, previous);
      return;
    }
    const customer = await tx.exchangeCustomer.findUnique({
      where: { customer_id: event.customerId },
    });
    if (!customer || customer.domain_id !== event.domainId)
      throw new ActionRejectedError('Withdrawal customer is not registered in this custody domain');
    const hot = await tx.exchangeWallet.findUnique({
      where: { wallet_id: event.data.hotWalletId },
    });
    const principal = event.data.principal;
    if (
      !hot ||
      hot.role !== 'hot' ||
      hot.domain_id !== event.domainId ||
      hot.reset_epoch !== event.resetEpoch ||
      hot.chain !== principal.asset.chain ||
      hot.network !== principal.asset.network
    )
      throw new ActionRejectedError('Withdrawal hot wallet registry identity is invalid');
    const alreadyExecuting = await tx.exchangeOperation.findUnique({
      where: { id: event.operationId },
    });
    if (alreadyExecuting)
      throw new ActionRejectedError('Cannot create a hold for an existing execution operation');
    let rejection: { code: string; reason: string } | undefined;
    if (customer.state !== 'active')
      rejection = { code: 'customer_frozen', reason: 'Customer withdrawals are frozen' };
    else if (Date.parse(event.data.quoteExpiresAt) <= Date.now())
      rejection = {
        code: 'quote_expired',
        reason: 'The accepted withdrawal quote expired before reservation',
      };
    else {
      for (const amount of amounts) {
        const balance = await this.journal.balance(
          tx,
          this.account(event, amount, 'customer_available'),
        );
        if (balance < BigInt(amount.amount)) {
          rejection = {
            code: 'insufficient_balance',
            reason: 'Customer available balance cannot cover the accepted withdrawal',
          };
          break;
        }
      }
    }
    const id = randomUUID();
    let batchId: string | undefined;
    if (!rejection) {
      const batch = await this.journal.post(tx, {
        key: `reservation:${id}:reserve`,
        domainId: event.domainId,
        operationId: event.operationId,
        revision: event.revision,
        kind: 'withdrawal.reserve',
        postings: amounts.flatMap((amount) => [
          {
            account: this.account(event, amount, 'customer_available'),
            side: 'debit' as const,
            amount: BigInt(amount.amount),
          },
          {
            account: this.account(event, amount, 'customer_reserved'),
            side: 'credit' as const,
            amount: BigInt(amount.amount),
          },
        ]),
      });
      batchId = batch.id;
    }
    const reservation = await tx.withdrawalReservation.create({
      data: {
        id,
        operation_id: event.operationId,
        domain_id: event.domainId,
        customer_id: event.customerId,
        request_digest: event.requestDigest,
        policy_version: event.policyVersion,
        revision: event.revision,
        state: rejection ? 'rejected' : 'held',
        amounts,
        request: {
          identity: immutable,
          source: event,
          ...(rejection ? { rejection } : {}),
        } as unknown as LedgerPrisma.InputJsonValue,
        reserve_batch_id: batchId,
        reset_epoch: event.resetEpoch,
      },
    });
    await this.result(tx, event, reservation);
  }

  private async release(tx: LedgerPrisma.TransactionClient, event: ReleaseEvent) {
    const reservation = await tx.withdrawalReservation.findUnique({
      where: { id: event.data.reservationId },
    });
    if (
      !reservation ||
      reservation.operation_id !== event.operationId ||
      reservation.domain_id !== event.domainId ||
      reservation.customer_id !== event.customerId ||
      reservation.request_digest !== event.requestDigest ||
      reservation.reset_epoch !== event.resetEpoch
    )
      throw new ActionRejectedError('Reservation release identity is invalid');
    if (reservation.state === 'released') {
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'reservation.released.v1',
          data: {
            reservationId: reservation.id,
            ledgerBatchId: reservation.release_batch_id!,
          },
        },
        `reservation:${reservation.id}:released`,
      );
      return;
    }
    const operation = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (
      operation &&
      (operation.domain_id !== event.domainId ||
        operation.request_digest !== event.requestDigest ||
        operation.reservation_id !== reservation.id ||
        operation.reset_epoch !== event.resetEpoch)
    )
      throw new ActionRejectedError('Reservation execution identity is invalid');
    if (!['held', 'frozen'].includes(reservation.state) || operation) {
      await publishExchangeEvent(
        tx,
        event,
        {
          type: 'reservation.release.rejected.v1',
          data: {
            reservationId: reservation.id,
            reason:
              'Recorded execution intents retain their reservation until explicit nonpayment proof; delayed signing observations cannot authorize release',
          },
        },
        `reservation:${reservation.id}:release-rejected:${event.revision}`,
      );
      return;
    }
    const postings = await this.releasePostings(tx, reservation);
    const batch = await this.journal.post(tx, {
      key: `reservation:${reservation.id}:release`,
      domainId: event.domainId,
      operationId: event.operationId,
      revision: event.revision,
      kind: 'withdrawal.release',
      postings,
      reversalOfBatchId: reservation.reserve_batch_id ?? undefined,
    });
    await tx.withdrawalReservation.update({
      where: { id: reservation.id },
      data: {
        state: 'released',
        release_batch_id: batch.id,
        revision: Math.max(reservation.revision, event.revision),
      },
    });
    await publishExchangeEvent(
      tx,
      event,
      {
        type: 'reservation.released.v1',
        data: {
          reservationId: reservation.id,
          ledgerBatchId: batch.id,
        },
      },
      `reservation:${reservation.id}:released`,
    );
  }

  async releasePostings(
    tx: LedgerPrisma.TransactionClient,
    reservation: WithdrawalReservation,
  ): Promise<JournalPosting[]> {
    const customer = await tx.exchangeCustomer.findUniqueOrThrow({
      where: { customer_id: reservation.customer_id },
    });
    const saved = reservation.request as unknown as { source: ReserveEvent };
    const event = saved.source;
    if (event.domainId !== reservation.domain_id || event.customerId !== reservation.customer_id)
      throw new ActionRejectedError('Reservation stored ownership identity is invalid');
    const amounts = reservation.amounts as unknown as Amount[];
    const postings: JournalPosting[] = [];
    for (const amount of amounts) {
      const value = BigInt(amount.amount);
      const deficitAccount = this.account(event, amount, 'deficit');
      const deficit =
        customer.state === 'frozen' ? await this.journal.balance(tx, deficitAccount) : 0n;
      const recovery = deficit < value ? deficit : value;
      postings.push({
        account: this.account(event, amount, 'customer_reserved'),
        side: 'debit',
        amount: value,
      });
      if (recovery > 0n)
        postings.push({ account: deficitAccount, side: 'credit', amount: recovery });
      if (value > recovery)
        postings.push({
          account: this.account(
            event,
            amount,
            customer.state === 'frozen' ? 'customer_frozen' : 'customer_available',
          ),
          side: 'credit',
          amount: value - recovery,
        });
    }
    return postings;
  }

  async get(domainId: string, reservationId: string) {
    return this.db.withdrawalReservation.findFirst({
      where: { id: reservationId, domain_id: domainId },
    });
  }

  async recordReconciliation(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (event.type !== 'operation.reconcile.responded.v1')
      throw new ActionRejectedError('Unsupported reservation reconciliation event');
    if (event.resetEpoch !== this.config.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    await this.db.$transaction(async (tx) =>
      consumeExchangeEvent(tx, event, async () => {
        const reservation = await tx.withdrawalReservation.findUnique({
          where: { operation_id: event.operationId },
        });
        if (
          !reservation ||
          reservation.domain_id !== event.domainId ||
          reservation.request_digest !== event.requestDigest ||
          reservation.reset_epoch !== event.resetEpoch ||
          (event.customerId !== undefined && event.customerId !== reservation.customer_id)
        )
          throw new ActionRejectedError('Reservation reconciliation identity is invalid');
        if (!['held', 'frozen'].includes(reservation.state)) return;
        if (
          event.data.found &&
          !['cancelled', 'rejected', 'settled'].includes(event.data.state ?? '')
        )
          return;
        const reason =
          'Reservation cannot be reconciled with the Wallet operation; explicit payment or nonpayment proof is required';
        const previous = await tx.ledgerIncident.findFirst({
          where: {
            domain_id: event.domainId,
            operation_id: event.operationId,
            reason,
            state: { in: ['open', 'investigating'] },
          },
        });
        if (previous) {
          await tx.ledgerIncident.update({
            where: { id: previous.id },
            data: {
              amount: { reservationId: reservation.id, evidence: event.data },
            },
          });
          return;
        }
        const incidentId = randomUUID();
        await tx.ledgerIncident.create({
          data: {
            id: incidentId,
            domain_id: event.domainId,
            customer_id: reservation.customer_id,
            operation_id: event.operationId,
            reason,
            state: 'open',
            amount: { reservationId: reservation.id, evidence: event.data },
          },
        });
        await publishExchangeEvent(
          tx,
          event,
          {
            type: 'custody.incident.opened.v1',
            data: {
              incidentId,
              severity: 'high',
              category: 'orphan_reservation',
              status: 'open',
              reason,
            },
          },
          `reservation:${reservation.id}:orphan-incident:${incidentId}`,
        );
      }),
    );
  }

  async list(domainId: string, cursor?: string, limit = 100) {
    return this.db.withdrawalReservation.findMany({
      where: { domain_id: domainId, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async reconcile(domainId: string, limit = 100) {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-domain:${domainId}`);
      const reservations = await tx.withdrawalReservation.findMany({
        where: {
          domain_id: domainId,
          reset_epoch: this.config.resetEpoch,
          state: { in: ['held', 'frozen'] },
        },
        orderBy: { updated_at: 'asc' },
        take: Math.min(Math.max(limit, 1), 100),
      });
      for (const reservation of reservations) {
        const saved = reservation.request as unknown as { source: ReserveEvent };
        await this.result(tx, saved.source, reservation, `:reconcile:${randomUUID()}`);
        await publishExchangeEvent(
          tx,
          saved.source,
          {
            type: 'operation.reconcile.requested.v1',
            data: {
              reservationId: reservation.id,
            },
          },
          `reservation:${reservation.id}:reconcile:${randomUUID()}`,
        );
        await tx.withdrawalReservation.update({
          where: { id: reservation.id },
          data: { updated_at: new Date() },
        });
      }
      return reservations.length;
    });
  }
}
