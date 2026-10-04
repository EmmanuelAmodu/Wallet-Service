import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { ActivityPrismaService } from '../apps/activity-listener/src/prisma/prisma.service.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { ActivityRegistryService } from '../apps/activity-listener/src/registry/registry.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { migrate } from '../scripts/migrate.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_ACTIVITY_DATABASE_URL;
const wallet = enabled ? createDatabase(process.env.TEST_DATABASE_URL!) : undefined;
const activity = enabled
  ? new ActivityPrismaService({ databaseUrl: process.env.TEST_ACTIVITY_DATABASE_URL! })
  : undefined;
const domainId = `registry-test-${randomUUID()}`;
const auth = new MessageAuth('a'.repeat(64), 'registry-test');
const eventIds: string[] = [];
const walletService = wallet
  ? new ExchangeMessagingService(wallet as WalletPrismaService, auth)
  : undefined;
const activityService = activity ? new ActivityRegistryService(activity, auth) : undefined;

function event<T extends ExchangeEvent['type']>(
  type: T,
  data: unknown,
  extra: Record<string, unknown> = {},
) {
  const parsed = exchangeEventSchema.parse({
    eventId: randomUUID(),
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId,
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision: 1,
    type,
    data,
    ...extra,
  });
  eventIds.push(parsed.eventId);
  return parsed as Extract<ExchangeEvent, { type: T }>;
}

function registration() {
  return event(
    'customer-wallet.registry.requested.v1',
    {
      walletId: randomUUID(),
      chain: 'ethereum',
      network: '11155111',
      address: '0x' + randomUUID().replaceAll('-', '').padEnd(40, '0'),
      hotWalletId: randomUUID(),
      account: 10,
      registryRevision: 1,
    },
    { customerId: randomUUID() },
  );
}

before(async () => {
  if (enabled) {
    await migrate(process.env.TEST_DATABASE_URL!);
    await migrate(process.env.TEST_ACTIVITY_DATABASE_URL!, 'activity');
  }
});
after(async () => {
  if (!enabled) return;
  const outboxFilter = { payload: { path: ['domainId'], equals: domainId } };
  const inboxFilter = {
    id: { in: eventIds.flatMap((id) => [`wallet:${id}`, `activity-listener:${id}`]) },
  };
  await wallet!.outbox.deleteMany({ where: outboxFilter });
  await activity!.outbox.deleteMany({ where: outboxFilter });
  await wallet!.inbox.deleteMany({ where: inboxFilter });
  await activity!.inbox.deleteMany({ where: inboxFilter });
  await wallet!.exchangeEventReceipt.deleteMany({ where: { event_id: { in: eventIds } } });
  await wallet!.exchangeOperationProjection.deleteMany({ where: { domain_id: domainId } });
  await wallet!.exchangeWalletRegistry.deleteMany({ where: { domain_id: domainId } });
  await activity!.exchangeWalletRegistration.deleteMany({ where: { domain_id: domainId } });
  await wallet!.$disconnect();
  await activity!.$disconnect();
});

test(
  'registry fan-out and consumer-owned persistence never mistake projection for provider readiness',
  { skip: !enabled },
  async () => {
    const request = registration();
    await walletService!.publishRegistry(request);
    await walletService!.publishRegistry(request);
    const deliveries = await wallet!.outbox.findMany({
      where: { dedupe_key: { contains: request.eventId } },
    });
    assert.equal(deliveries.length, 2);
    assert.deepEqual(
      new Set(deliveries.map((row) => row.queue)),
      new Set([QUEUES.ledger, QUEUES.activity]),
    );
    assert.notEqual(deliveries[0].id, deliveries[1].id);
    await activityService!.register(request);
    await activityService!.register(request);
    const listenerRows = await activity!.outbox.findMany({
      where: { payload: { path: ['causationId'], equals: request.eventId } },
    });
    assert.equal(listenerRows.length, 1);
    const listenerAck = exchangeEventSchema.parse(listenerRows[0].payload);
    eventIds.push(listenerAck.eventId);
    assert.equal(listenerAck.type, 'customer-wallet.registry.acknowledged.v1');
    if (listenerAck.type !== 'customer-wallet.registry.acknowledged.v1')
      throw new Error('Unexpected acknowledgment');
    assert.equal(listenerAck.data.status, 'rejected');
    assert.equal(listenerAck.data.coverageComplete, false);
    const ledgerAck = event(
      'customer-wallet.registry.acknowledged.v1',
      { walletId: request.data.walletId, consumer: 'ledger', status: 'ready', registryRevision: 1 },
      { customerId: request.customerId },
    );
    await walletService!.handle(ledgerAck);
    await walletService!.handle(listenerAck);
    await walletService!.handle(listenerAck);
    const projection = await wallet!.exchangeWalletRegistry.findUniqueOrThrow({
      where: { wallet_id: request.data.walletId },
    });
    assert.equal(projection.ledger_status, 'ready');
    assert.equal(projection.listener_status, 'rejected');
    assert.equal(projection.ready, false);
    assert.match(projection.listener_reason!, /phase3/);
    assert.equal(
      await activity!.inbox.count({ where: { id: `activity-listener:${request.eventId}` } }),
      1,
    );
    assert.equal(await wallet!.inbox.count({ where: { id: `wallet:${listenerAck.eventId}` } }), 1);
  },
);

test(
  'changed event identity rolls back registry changes and acknowledgments cannot cross revisions',
  { skip: !enabled },
  async () => {
    const request = registration();
    await walletService!.publishRegistry(request);
    const changedIdentity = {
      ...request,
      revision: 2,
      data: { ...request.data, registryRevision: 2 },
    };
    await assert.rejects(
      () => walletService!.publishRegistry(changedIdentity),
      /different outbox content/,
    );
    assert.equal(
      (
        await wallet!.exchangeWalletRegistry.findUniqueOrThrow({
          where: { wallet_id: request.data.walletId },
        })
      ).registry_revision,
      1,
    );
    await activityService!.register(request);
    await assert.rejects(
      () =>
        activityService!.register({
          ...request,
          data: { ...request.data, address: '0x' + 'ff'.repeat(20) },
        }),
      /different content/,
    );
    const revision2 = event(
      'customer-wallet.registry.requested.v1',
      { ...request.data, registryRevision: 2 },
      {
        customerId: request.customerId,
        aggregateId: request.aggregateId,
        revision: 2,
      },
    );
    await walletService!.publishRegistry(revision2);
    const stale = event(
      'customer-wallet.registry.acknowledged.v1',
      { walletId: request.data.walletId, consumer: 'ledger', status: 'ready', registryRevision: 1 },
      { revision: 100 },
    );
    await walletService!.handle(stale);
    const projection = await wallet!.exchangeWalletRegistry.findUniqueOrThrow({
      where: { wallet_id: request.data.walletId },
    });
    assert.equal(projection.registry_revision, 2);
    assert.equal(projection.ledger_status, 'pending');
    assert.equal(projection.ready, false);
    assert.equal(
      exchangeEventSchema.safeParse({
        ...stale,
        data: { ...stale.data, consumer: 'activity-listener', registryRevision: 2 },
      }).success,
      false,
    );
  },
);

test(
  'Wallet operation reconciliation is durable evidence and never automatically releases a missing hold',
  { skip: !enabled },
  async () => {
    const operationId = randomUUID();
    const request = event(
      'operation.reconcile.requested.v1',
      { reservationId: randomUUID() },
      {
        operationId,
        customerId: randomUUID(),
        requestDigest: 'b'.repeat(64),
      },
    );
    await walletService!.handle(request);
    await walletService!.handle(request);
    const replies = await wallet!.outbox.findMany({
      where: { payload: { path: ['causationId'], equals: request.eventId } },
    });
    assert.equal(replies.length, 1);
    const response = exchangeEventSchema.parse(replies[0].payload);
    eventIds.push(response.eventId);
    assert.equal(response.type, 'operation.reconcile.responded.v1');
    if (response.type !== 'operation.reconcile.responded.v1')
      throw new Error('Unexpected response');
    assert.equal(response.data.found, false);
    assert.equal(
      await wallet!.exchangeOperationProjection.count({ where: { operation_id: operationId } }),
      0,
    );
    assert.equal(replies[0].queue, QUEUES.ledger);
  },
);

test(
  'late execution events cannot regress a settled obligation; explicit reversal requires reconciliation',
  { skip: !enabled },
  async () => {
    const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' };
    const operationId = randomUUID();
    const customerId = randomUUID();
    const requestDigest = 'c'.repeat(64);
    const request = event(
      'withdrawal.reserve.requested.v1',
      {
        principal: { asset, amount: '100' },
        hotWalletId: randomUUID(),
        amounts: [{ asset, amount: '100' }],
        destination: '0x' + 'ab'.repeat(20),
        quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
      },
      { operationId, customerId, requestDigest, policyVersion: 'v1' },
    );
    await walletService!.publishOperation(request, [QUEUES.ledger]);
    const attemptId = randomUUID();
    await walletService!.handle(
      event(
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: '0xtransaction' },
        { operationId, attemptId, requestDigest, customerId, revision: 2 },
      ),
    );
    await walletService!.handle(
      event(
        'execution.attempt.updated.v1',
        { state: 'submitted' },
        { operationId, attemptId, requestDigest, customerId, revision: 99 },
      ),
    );
    assert.equal(
      (
        await wallet!.exchangeOperationProjection.findUniqueOrThrow({
          where: { operation_id: operationId },
        })
      ).state,
      'settled',
    );
    await walletService!.handle(
      event(
        'settlement.reversed.v1',
        { ledgerBatchId: randomUUID(), priorSettlementRevision: 2 },
        { operationId, attemptId, requestDigest, customerId, revision: 100 },
      ),
    );
    assert.equal(
      (
        await wallet!.exchangeOperationProjection.findUniqueOrThrow({
          where: { operation_id: operationId },
        })
      ).state,
      'reconciliation_required',
    );
  },
);

test(
  'execution and settlement revisions are independent and a reversal fences delayed results',
  { skip: !enabled },
  async () => {
    const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' };
    const operationId = randomUUID();
    const customerId = randomUUID();
    const requestDigest = 'd'.repeat(64);
    const request = event(
      'withdrawal.reserve.requested.v1',
      {
        principal: { asset, amount: '100' },
        hotWalletId: randomUUID(),
        amounts: [{ asset, amount: '100' }],
        destination: '0x' + 'ab'.repeat(20),
        quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
      },
      { operationId, customerId, requestDigest, policyVersion: 'v1' },
    );
    await walletService!.publishOperation(request, [QUEUES.ledger]);
    const attemptId = randomUUID();
    const identity = { operationId, attemptId, requestDigest, customerId };
    const projection = () =>
      wallet!.exchangeOperationProjection.findUniqueOrThrow({
        where: { operation_id: operationId },
      });
    await walletService!.handle(
      event('execution.attempt.updated.v1', { state: 'submitted' }, { ...identity, revision: 99 }),
    );
    await walletService!.handle(
      event(
        'withdrawal.reserved.v1',
        { reservationId: randomUUID(), ledgerBatchId: randomUUID() },
        { ...identity, revision: 1 },
      ),
    );
    assert.equal((await projection()).state, 'executing');
    await walletService!.handle(
      event(
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: '0xtransaction' },
        { ...identity, revision: 1 },
      ),
    );
    assert.equal((await projection()).state, 'settled');
    await walletService!.handle(
      event(
        'settlement.reversed.v1',
        { ledgerBatchId: randomUUID(), priorSettlementRevision: 1 },
        { ...identity, revision: 2 },
      ),
    );
    await walletService!.handle(
      event('execution.attempt.updated.v1', { state: 'attention' }, { ...identity, revision: 100 }),
    );
    await walletService!.handle(
      event(
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: '0xtransaction' },
        { ...identity, revision: 1 },
      ),
    );
    assert.equal((await projection()).state, 'reconciliation_required');
    await walletService!.handle(
      event(
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: '0xtransaction' },
        { ...identity, revision: 3 },
      ),
    );
    const final = await projection();
    assert.equal(final.state, 'settled');
    assert.deepEqual(final.result_revisions, { execution: 99, settlement: 3 });
  },
);
