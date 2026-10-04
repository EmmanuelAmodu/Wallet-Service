import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ActivityPrismaService } from '../prisma/prisma.service.js';
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

@Injectable()
export class ActivityRegistryService {
  constructor(
    @Inject(ActivityPrismaService) private readonly db: ActivityPrismaService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
  ) {}

  async register(input: RegistryRequest) {
    const event = exchangeEventSchema.parse(input) as RegistryRequest;
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale registry epoch');
    const data = event.data;
    const address = isEvmChain(data.chain) ? data.address.toLowerCase() : data.address;
    const role =
      event.type === 'customer-wallet.registry.requested.v1' ? 'customer_deposit' : event.data.role;
    const customerId =
      event.type === 'customer-wallet.registry.requested.v1' ? event.customerId : null;
    const hotWalletId =
      event.type === 'customer-wallet.registry.requested.v1' ? event.data.hotWalletId : null;
    const inboxId = `activity-listener:${event.eventId}`;
    const payloadHash = createHash('sha256').update(canonical(event)).digest('hex');
    await this.db.$transaction(async (db) => {
      await lock(db, inboxId);
      const seen = await db.inbox.findUnique({ where: { id: inboxId } });
      if (seen) {
        if (seen.payload_hash !== payloadHash)
          throw new ActionRejectedError('Event identity reused with different content');
        return;
      }
      await lock(db, `registry:${data.walletId}`);
      const current = await db.exchangeWalletRegistration.findUnique({
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
      if (!current || data.registryRevision >= current.registry_revision) {
        if (
          current &&
          data.registryRevision === current.registry_revision &&
          (current.hot_wallet_id !== hotWalletId ||
            canonical((current.request as unknown as RegistryRequest).data) !== canonical(data))
        )
          throw new ActionRejectedError('Registry revision reused with different content');
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
          status: 'awaiting_provider_coverage',
          start_cursor:
            event.type === 'customer-wallet.registry.requested.v1'
              ? (event.data.startCursor ?? null)
              : null,
        };
        await db.exchangeWalletRegistration.upsert({
          where: { wallet_id: data.walletId },
          create: { wallet_id: data.walletId, ...row },
          update: row,
        });
        // Persistence is not provider readiness. Phase 3 must install watches and prove initial coverage.
        const ack = exchangeEventSchema.parse({
          eventId: randomUUID(),
          schemaVersion: 1,
          resetEpoch: event.resetEpoch,
          occurredAt: new Date().toISOString(),
          domainId: event.domainId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          aggregateId: event.aggregateId,
          revision: event.revision,
          ...(customerId ? { customerId } : {}),
          type: 'customer-wallet.registry.acknowledged.v1',
          data: {
            walletId: data.walletId,
            consumer: 'activity-listener',
            registryRevision: data.registryRevision,
            status: 'rejected',
            coverageComplete: false,
            reason: 'awaiting_phase3_provider_watch_and_backfill_coverage',
          },
        });
        await enqueueFanOut(db, ack, [QUEUES.wallet]);
      }
      await db.inbox.create({ data: { id: inboxId, payload_hash: payloadHash } });
    });
  }
}
