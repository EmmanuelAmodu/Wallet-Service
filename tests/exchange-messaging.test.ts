import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  exchangeEventSchema,
  ExchangeEvent,
  canonicalAssetSchema,
} from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { enqueueFanOut } from '../packages/queue/src/outbox.service.js';

const native = {
  chain: 'ethereum' as const,
  network: '11155111',
  assetId: 'token:ethereum:native',
};

function reservation() {
  return exchangeEventSchema.parse({
    eventId: randomUUID(),
    type: 'withdrawal.reserve.requested.v1',
    schemaVersion: 1,
    resetEpoch: 'exchange-test',
    occurredAt: new Date().toISOString(),
    domainId: 'test',
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision: 1,
    customerId: randomUUID(),
    operationId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    policyVersion: 'v1',
    data: {
      principal: { asset: native, amount: '100' },
      customerFee: { asset: native, amount: '2' },
      hotWalletId: randomUUID(),
      amounts: [{ asset: native, amount: '102' }],
      destination: '0x' + 'ab'.repeat(20),
      quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
    },
  });
}

test('exchange message HMAC binds business epoch and transport epoch together', () => {
  const event = reservation();
  const auth = new MessageAuth('a'.repeat(64), 'exchange-test');
  const sealed = auth.seal(event);
  assert.deepEqual(auth.open(sealed, sealed.id, event.type), event);
  assert.throws(() => auth.seal({ ...event, resetEpoch: 'old' }), /business reset epoch/);
  const substituted = { ...sealed, payload: { ...event, resetEpoch: 'old' } };
  assert.throws(() => auth.open(substituted, sealed.id, event.type), /business reset epoch/);
});
test('reservation contracts require exact principal plus fee grouped by asset', () => {
  const event = reservation();
  if (event.type !== 'withdrawal.reserve.requested.v1') throw new Error('Unexpected fixture');
  for (const amounts of [
    [],
    [{ asset: native, amount: '100' }],
    [
      { asset: native, amount: '102' },
      { asset: native, amount: '1' },
    ],
  ])
    assert.equal(
      exchangeEventSchema.safeParse({ ...event, data: { ...event.data, amounts } }).success,
      false,
    );
  assert.equal(
    exchangeEventSchema.safeParse({ ...event, data: { ...event.data, principal: undefined } })
      .success,
    false,
  );
  assert.equal(
    exchangeEventSchema.safeParse({
      ...event,
      data: { ...event.data, customerFee: { asset: native, amount: '0' } },
    }).success,
    false,
  );
});
test('canonical token assets reject case variants and unsupported protocol-family combinations', () => {
  assert.equal(
    canonicalAssetSchema.safeParse({
      ...native,
      assetId: 'token:ethereum:erc20:0x' + 'AB'.repeat(20),
    }).success,
    false,
  );
  assert.equal(
    canonicalAssetSchema.safeParse({
      chain: 'bitcoin',
      network: 'regtest',
      assetId: 'token:bitcoin:erc20:0x' + 'ab'.repeat(20),
    }).success,
    false,
  );
  assert.equal(
    canonicalAssetSchema.safeParse({
      ...native,
      assetId: 'token:ethereum:erc20:0x' + 'ab'.repeat(20),
    }).success,
    true,
  );
});
test('fan-out gives each consumer a distinct stable durable delivery', async () => {
  const rows = new Map<
    string,
    { id: string; queue: string; payload: ExchangeEvent; dedupe_key: string }
  >();
  const database = {
    outbox: {
      upsert: async ({
        create,
      }: {
        create: { id: string; queue: string; payload: ExchangeEvent; dedupe_key: string };
      }) => {
        if (!rows.has(create.dedupe_key)) rows.set(create.dedupe_key, create);
        return rows.get(create.dedupe_key)!;
      },
    },
  };
  const event = reservation();
  const first = await enqueueFanOut(database as never, event, [QUEUES.wallet, QUEUES.ledger]);
  const replay = await enqueueFanOut(database as never, event, [QUEUES.wallet, QUEUES.ledger]);
  assert.equal(rows.size, 2);
  assert.notEqual(first[0].id, first[1].id);
  assert.deepEqual(
    replay.map((row) => row.id),
    first.map((row) => row.id),
  );
  assert(first.every((row) => (row.payload as ExchangeEvent).eventId === event.eventId));
  await assert.rejects(
    () => enqueueFanOut(database as never, event, [QUEUES.wallet, QUEUES.wallet]),
    /distinct/,
  );
  await assert.rejects(
    () =>
      enqueueFanOut(database as never, { ...event, revision: event.revision + 1 }, [
        QUEUES.wallet,
        QUEUES.ledger,
      ]),
    /different outbox content/,
  );
});
