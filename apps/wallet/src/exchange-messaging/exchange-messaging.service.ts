import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { isEvmChain } from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';

type RegistryRequest = Extract<
  ExchangeEvent,
  { type: 'customer-wallet.registry.requested.v1' | 'custody-wallet.registry.requested.v1' }
>;
type OperationRequest = Extract<
  ExchangeEvent,
  {
    type:
      | 'withdrawal.reserve.requested.v1'
      | 'sweep.execute.requested.v1'
      | 'withdrawal.execute.requested.v1'
      | 'funding.execute.requested.v1';
  }
>;

@Injectable()
export class ExchangeMessagingService {
  constructor(
    @Inject(WalletPrismaService) private readonly db: WalletPrismaService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
  ) {}

  private parse(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale exchange epoch');
    return event;
  }

  // Phase 1 calls this while creating the owned custody/customer model; no public address API is enabled here.
  async publishRegistry(input: RegistryRequest, transaction?: Prisma.TransactionClient) {
    const event = this.parse(input) as RegistryRequest;
    const apply = async (db: Prisma.TransactionClient) => {
      const data = event.data;
      const role =
        event.type === 'customer-wallet.registry.requested.v1'
          ? 'customer_deposit'
          : event.data.role;
      const customerId =
        event.type === 'customer-wallet.registry.requested.v1' ? event.customerId : null;
      const hotWalletId =
        event.type === 'customer-wallet.registry.requested.v1' ? event.data.hotWalletId : null;
      const address = isEvmChain(data.chain) ? data.address.toLowerCase() : data.address;
      await lock(db, `exchange-registry:${data.walletId}`);
      const current = await db.exchangeWalletRegistry.findUnique({
        where: { wallet_id: data.walletId },
      });
      if (
        current &&
        (current.domain_id !== event.domainId ||
          current.reset_epoch !== event.resetEpoch ||
          current.chain !== data.chain ||
          current.network !== data.network ||
          current.address !== address ||
          current.role !== role ||
          current.account !== data.account ||
          current.customer_id !== customerId)
      )
        throw new ActionRejectedError('Published wallet registry identity is immutable');
      if (current && data.registryRevision < current.registry_revision) return;
      if (current && data.registryRevision === current.registry_revision) {
        if (
          canonical((current.request as unknown as RegistryRequest).data) !== canonical(event.data)
        )
          throw new ActionRejectedError('Registry revision reused with different content');
        await enqueueFanOut(db, event, [QUEUES.ledger, QUEUES.activity]);
        return;
      }
      const row = {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        chain: data.chain,
        network: data.network,
        address,
        role,
        account: data.account,
        customer_id: customerId,
        hot_wallet_id: hotWalletId,
        registry_revision: data.registryRevision,
        request: event as unknown as Prisma.InputJsonValue,
        ledger_status: 'pending',
        listener_status: 'pending',
        ledger_ack_revision: 0,
        listener_ack_revision: 0,
        ledger_reason: null,
        listener_reason: null,
        start_cursor: null,
        ready: false,
      };
      await db.exchangeWalletRegistry.upsert({
        where: { wallet_id: data.walletId },
        create: { wallet_id: data.walletId, ...row },
        update: row,
      });
      await enqueueFanOut(db, event, [QUEUES.ledger, QUEUES.activity]);
    };
    if (transaction) await apply(transaction);
    else await this.db.$transaction(apply);
  }

  async publishOperation(
    input: OperationRequest,
    queues: readonly string[],
    transaction?: Prisma.TransactionClient,
  ) {
    const event = this.parse(input) as OperationRequest;
    const apply = async (db: Prisma.TransactionClient) => {
      await lock(db, `exchange-operation:${event.operationId}`);
      const current = await db.exchangeOperationProjection.findUnique({
        where: { operation_id: event.operationId },
      });
      if (
        current &&
        (current.domain_id !== event.domainId ||
          current.reset_epoch !== event.resetEpoch ||
          current.request_digest !== event.requestDigest ||
          current.customer_id !== (event.customerId ?? null))
      )
        throw new ActionRejectedError('Operation identity reused with different intent');
      if (!current)
        await db.exchangeOperationProjection.create({
          data: {
            operation_id: event.operationId,
            domain_id: event.domainId,
            reset_epoch: event.resetEpoch,
            customer_id: event.customerId ?? null,
            request_digest: event.requestDigest,
            source_type: event.type,
            request: event as unknown as Prisma.InputJsonValue,
            state: 'requested',
          },
        });
      else if (
        current.source_type === event.type &&
        canonical((current.request as unknown as OperationRequest).data) !== canonical(event.data)
      )
        throw new ActionRejectedError('Operation request is immutable');
      await enqueueFanOut(db, event, queues);
    };
    if (transaction) await apply(transaction);
    else await this.db.$transaction(apply);
  }

  async handle(input: ExchangeEvent) {
    const event = this.parse(input);
    const hash = createHash('sha256').update(canonical(event)).digest('hex');
    await this.db.$transaction(async (db) => {
      await lock(db, `wallet:${event.eventId}`);
      const seen = await db.exchangeEventReceipt.findUnique({ where: { event_id: event.eventId } });
      if (seen) {
        if (seen.payload_hash !== hash)
          throw new ActionRejectedError('Event identity reused with different content');
        return;
      }
      if (event.type === 'customer-wallet.registry.acknowledged.v1') {
        const data = event.data;
        await lock(db, `exchange-registry:${data.walletId}`);
        const registry = await db.exchangeWalletRegistry.findUnique({
          where: { wallet_id: data.walletId },
        });
        if (!registry) throw new Error('Registry request has not committed yet');
        if (registry.domain_id !== event.domainId || registry.reset_epoch !== event.resetEpoch)
          throw new ActionRejectedError('Registry acknowledgment domain/epoch mismatch');
        if (data.registryRevision === registry.registry_revision) {
          const previousRevision =
            data.consumer === 'ledger'
              ? registry.ledger_ack_revision
              : registry.listener_ack_revision;
          if (event.revision > previousRevision) {
            const patch =
              data.consumer === 'ledger'
                ? {
                    ledger_status: data.status,
                    ledger_ack_revision: event.revision,
                    ledger_reason: data.reason ?? null,
                  }
                : {
                    listener_status: data.status,
                    listener_ack_revision: event.revision,
                    listener_reason: data.reason ?? null,
                    start_cursor: data.backfillCursor ?? null,
                  };
            const updated = await db.exchangeWalletRegistry.update({
              where: { wallet_id: data.walletId },
              data: patch,
            });
            // Listener "ready" is schema-validated to include complete initial backfill coverage.
            await db.exchangeWalletRegistry.update({
              where: { wallet_id: data.walletId },
              data: {
                ready:
                  updated.ledger_status === 'ready' &&
                  updated.listener_status === 'ready' &&
                  !!updated.start_cursor,
              },
            });
          }
        }
      } else if (event.type === 'operation.reconcile.requested.v1') {
        await lock(db, `exchange-operation:${event.operationId}`);
        const operation = await db.exchangeOperationProjection.findUnique({
          where: { operation_id: event.operationId },
        });
        if (
          operation &&
          (operation.domain_id !== event.domainId ||
            operation.reset_epoch !== event.resetEpoch ||
            operation.request_digest !== event.requestDigest ||
            (event.customerId && operation.customer_id !== event.customerId))
        )
          throw new ActionRejectedError('Operation reconciliation identity mismatch');
        const response = exchangeEventSchema.parse({
          eventId: randomUUID(),
          schemaVersion: 1,
          resetEpoch: event.resetEpoch,
          occurredAt: new Date().toISOString(),
          domainId: event.domainId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          aggregateId: event.aggregateId,
          revision: event.revision,
          operationId: event.operationId,
          requestDigest: event.requestDigest,
          ...(event.customerId ? { customerId: event.customerId } : {}),
          type: 'operation.reconcile.responded.v1',
          data: {
            found: !!operation,
            ...(operation
              ? { state: operation.state, sourceRevision: Math.max(1, operation.result_revision) }
              : {}),
          },
        });
        await enqueueFanOut(db, response, [QUEUES.ledger]);
      } else if (event.operationId && event.requestDigest) {
        await lock(db, `exchange-operation:${event.operationId}`);
        const operation = await db.exchangeOperationProjection.findUnique({
          where: { operation_id: event.operationId },
        });
        if (operation) {
          if (
            operation.domain_id !== event.domainId ||
            operation.reset_epoch !== event.resetEpoch ||
            operation.request_digest !== event.requestDigest ||
            (event.customerId && operation.customer_id !== event.customerId)
          )
            throw new ActionRejectedError('Operation result identity mismatch');
          const states: Partial<Record<ExchangeEvent['type'], string>> = {
            'withdrawal.reserved.v1': 'reserved',
            'withdrawal.reserve.rejected.v1': 'rejected',
            'reservation.released.v1': 'cancelled',
            'reservation.release.rejected.v1': 'attention',
            'settlement.committed.v1': 'settled',
            'settlement.reversed.v1': 'reconciliation_required',
          };
          const state =
            event.type === 'execution.attempt.updated.v1'
              ? event.data.state === 'attention'
                ? 'attention'
                : 'executing'
              : states[event.type];
          const terminal = ['settled', 'cancelled', 'rejected', 'reconciliation_required'].includes(
            operation.state,
          );
          const stream = event.type.startsWith('settlement.')
            ? 'settlement'
            : event.type === 'execution.attempt.updated.v1'
              ? 'execution'
              : 'reservation';
          const revisions = operation.result_revisions as Record<string, number>;
          const previousRevision = revisions[stream] ?? 0;
          const settlementResult =
            event.type === 'settlement.committed.v1' || event.type === 'settlement.reversed.v1';
          const initialReservationResult =
            event.type === 'withdrawal.reserved.v1' ||
            event.type === 'withdrawal.reserve.rejected.v1';
          const canApply = settlementResult
            ? !['cancelled', 'rejected'].includes(operation.state)
            : !terminal &&
              (!initialReservationResult || ['requested', 'reserved'].includes(operation.state));
          if (state && event.revision > previousRevision && canApply)
            await db.exchangeOperationProjection.update({
              where: { operation_id: event.operationId },
              data: {
                state,
                result_revision: Math.max(operation.result_revision, event.revision),
                result_revisions: { ...revisions, [stream]: event.revision },
                result: event as unknown as Prisma.InputJsonValue,
              },
            });
        }
      }
      await db.exchangeEventReceipt.create({
        data: {
          event_id: event.eventId,
          payload_hash: hash,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      await db.inbox.create({ data: { id: `wallet:${event.eventId}` } });
    });
  }
}
