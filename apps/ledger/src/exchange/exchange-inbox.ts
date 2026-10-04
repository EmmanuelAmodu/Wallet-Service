import { createHash, randomUUID } from 'node:crypto';
import type { Prisma as LedgerPrisma } from '.prisma/ledger-client';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';

export function exchangeDigest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export async function consumeExchangeEvent(
  tx: LedgerPrisma.TransactionClient,
  event: ExchangeEvent,
  action: () => Promise<void>,
) {
  await lock(tx, `exchange-domain:${event.domainId}`);
  await lock(tx, `exchange-inbox:${event.eventId}`);
  const digest = exchangeDigest(event);
  const previous = await tx.exchangeInbox.findUnique({ where: { event_id: event.eventId } });
  if (previous) {
    if (previous.digest !== digest || previous.reset_epoch !== event.resetEpoch)
      throw new ActionRejectedError('Exchange event ID was reused with different content');
    return;
  }
  await action();
  await tx.exchangeInbox.create({
    data: { event_id: event.eventId, digest, reset_epoch: event.resetEpoch },
  });
}

export async function publishExchangeEvent(
  tx: LedgerPrisma.TransactionClient,
  source: ExchangeEvent,
  output: { type: string; data: unknown; revision?: number },
  key: string,
) {
  const event = exchangeEventSchema.parse({
    ...source,
    ...output,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    causationId: source.eventId,
  });
  return tx.outbox.upsert({
    where: { dedupe_key: key },
    update: {},
    create: {
      id: randomUUID(),
      queue: QUEUES.wallet,
      dedupe_key: key,
      payload: event as unknown as LedgerPrisma.InputJsonValue,
    },
  });
}
