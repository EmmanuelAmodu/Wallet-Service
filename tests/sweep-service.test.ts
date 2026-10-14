import { acceptanceRollout } from './helpers/rollout-fixture.js';
import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SweepPrismaService } from '../apps/sweep/src/prisma/prisma.service.js';
import { SweepService } from '../apps/sweep/src/sweep/sweep.service.js';
import { SweepProcessor } from '../apps/sweep/src/sweep/sweep.processor.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { ActionRejectedError } from '../packages/shared/src/action-rejected.error.js';
import { migrate } from '../scripts/migrate.js';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

const enabled = !!process.env.TEST_SWEEP_DATABASE_URL;
const db = enabled
  ? new SweepPrismaService({ databaseUrl: process.env.TEST_SWEEP_DATABASE_URL! })
  : undefined;
const auth = new MessageAuth('s'.repeat(64), 'sweep-test-epoch');
const domains = new Set<string>();
const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' } as const;

function fixture() {
  const domainId = `sweep-test-${randomUUID()}`;
  domains.add(domainId);
  const customerId = randomUUID();
  const walletId = randomUUID();
  const hotWalletId = randomUUID();
  const service = new SweepService(db!, auth, { domainId }, acceptanceRollout);
  const event = (type: string, data: unknown, extra: Record<string, unknown> = {}): ExchangeEvent =>
    exchangeEventSchema.parse({
      schemaVersion: 1,
      resetEpoch: auth.resetEpoch,
      domainId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: randomUUID(),
      revision: 1,
      customerId,
      type,
      data,
      ...extra,
    });
  const hot = event(
    'custody-wallet.registry.requested.v1',
    {
      walletId: hotWalletId,
      chain: asset.chain,
      network: asset.network,
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
      role: 'hot',
      account: 0,
      registryRevision: 1,
    },
    { customerId: undefined },
  );
  const source = event('customer-wallet.registry.requested.v1', {
    walletId,
    chain: asset.chain,
    network: asset.network,
    address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
    hotWalletId,
    account: 10,
    registryRevision: 1,
  });
  const credit = (amount = '100', extra: Record<string, unknown> = {}) =>
    event(
      'deposit.credited.v1',
      {
        depositId: randomUUID(),
        ledgerBatchId: randomUUID(),
        walletId,
        asset,
        amount,
      },
      extra,
    );
  const work = () =>
    db!.sweepWork.findFirstOrThrow({ where: { domain_id: domainId, source_wallet_id: walletId } });
  return { domainId, customerId, walletId, hotWalletId, service, event, hot, source, credit, work };
}

before(async () => {
  if (enabled) await migrate(process.env.TEST_SWEEP_DATABASE_URL!, 'sweep');
});
after(async () => {
  if (!enabled) return;
  const where = { domain_id: { in: [...domains] } };
  await db!.sweepWork.deleteMany({ where });
  await db!.sweepDeposit.deleteMany({ where });
  await db!.sweepWalletRegistration.deleteMany({ where });
  await db!.sweepCustomer.deleteMany({ where });
  await db!.sweepDomainGate.deleteMany({ where });
  await db!.inbox.deleteMany({ where });
  await db!.$disconnect();
});

test(
  'sweep coalesces only accounted native credits and absorbs duplicate deliveries durably',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const first = f.credit('900719925474099312345');
    const second = f.credit('17');
    await Promise.all([f.service.handle(first), f.service.handle(first), f.service.handle(second)]);
    const row = await f.work();
    assert.equal(row.observed_credit_units, '900719925474099312362');
    assert.equal(row.credited_deposit_count, 2);
    assert.equal(row.state, 'blocked_execution_not_implemented');
    assert.equal(row.hot_wallet_id, f.hotWalletId);
    await f.service.handle(first);
    assert.equal((await f.work()).revision, row.revision);
    await assert.rejects(
      f.service.handle({ ...first, correlationId: randomUUID() }),
      ActionRejectedError,
    );
    assert.equal(
      await db!.outbox.count({ where: { payload: { path: ['domainId'], equals: f.domainId } } }),
      0,
      'A planning hint must never create a signed action',
    );
  },
);

test(
  'sweep persists credits before registry deliveries and waits for the registered account 0 target',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.credit());
    assert.equal((await f.work()).state, 'awaiting_registry');
    await f.service.handle(f.source);
    assert.equal((await f.work()).state, 'awaiting_hot_wallet');
    await f.service.handle(f.hot);
    assert.equal((await f.work()).state, 'blocked_execution_not_implemented');
    assert.equal((await f.work()).observed_credit_units, '100');
  },
);

test(
  'sweep retains reversal-first tombstones and requires a newer credit revision to reconsider work',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const credit = f.credit();
    assert.equal(credit.type, 'deposit.credited.v1');
    if (credit.type !== 'deposit.credited.v1') throw new Error('Fixture mismatch');
    const reversal = f.event(
      'deposit.reversed.v1',
      {
        depositId: credit.data.depositId,
        ledgerBatchId: randomUUID(),
        asset,
        amount: '100',
        reason: 'Reorg',
      },
      { revision: 3 },
    );
    await f.service.handle(reversal);
    await f.service.handle(credit);
    assert.equal(await db!.sweepWork.count({ where: { domain_id: f.domainId } }), 0);
    assert.equal(
      (await db!.sweepDeposit.findUniqueOrThrow({ where: { deposit_id: credit.data.depositId } }))
        .state,
      'reversed',
    );
    await f.service.handle({ ...credit, eventId: randomUUID(), revision: 4 });
    assert.equal((await f.work()).observed_credit_units, '100');
    await f.service.handle(reversal);
    assert.equal((await f.work()).observed_credit_units, '100');
    await assert.rejects(
      f.service.handle({ ...reversal, eventId: randomUUID(), revision: 4 }),
      /revision content changed/,
    );
  },
);

test(
  'a reversal removes credited planning units without affecting other deposits',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const credit = f.credit('50');
    if (credit.type !== 'deposit.credited.v1') throw new Error('Fixture mismatch');
    await f.service.handle(credit);
    await f.service.handle(f.credit('20'));
    const reversal = f.event(
      'deposit.reversed.v1',
      {
        depositId: credit.data.depositId,
        ledgerBatchId: randomUUID(),
        asset,
        amount: '50',
        reason: 'Reorg',
      },
      { revision: 2 },
    );
    await f.service.handle(reversal);
    assert.equal((await f.work()).observed_credit_units, '20');
    assert.equal((await f.work()).credited_deposit_count, 1);
    assert.equal(
      await db!.outbox.count({ where: { payload: { path: ['domainId'], equals: f.domainId } } }),
      0,
    );
  },
);

test(
  'sweep rejects foreign domains, stale epochs, conflicting owners and changed immutable registry',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const credit = f.credit();
    await assert.rejects(
      f.service.handle({ ...credit, domainId: 'foreign' }),
      /different exchange custody domain/,
    );
    await assert.rejects(f.service.handle({ ...credit, resetEpoch: 'old' }), /Stale reset epoch/);
    await assert.rejects(
      f.service.handle({ ...credit, customerId: randomUUID() }),
      /source registry/,
    );
    if (f.source.type !== 'customer-wallet.registry.requested.v1')
      throw new Error('Fixture mismatch');
    await assert.rejects(
      f.service.handle({
        ...f.source,
        eventId: randomUUID(),
        data: { ...f.source.data, hotWalletId: randomUUID(), registryRevision: 2 },
      }),
      /immutable/,
    );
    assert.equal(await db!.sweepDeposit.count({ where: { domain_id: f.domainId } }), 0);
    assert.equal(await db!.inbox.count({ where: { id: credit.eventId } }), 0);
  },
);

test(
  'token credit projection defers unsupported assets without emitting execution',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const credit = f.credit();
    if (credit.type !== 'deposit.credited.v1') throw new Error('Fixture mismatch');
    await f.service.handle({
      ...credit,
      data: {
        ...credit.data,
        asset: { ...asset, assetId: `token:ethereum:erc20:0x${'a'.repeat(40)}` },
      },
    });
    assert.equal((await f.work()).state, 'deferred_unsupported_asset');
    assert.equal(
      await db!.outbox.count({ where: { payload: { path: ['domainId'], equals: f.domainId } } }),
      0,
    );
  },
);

test(
  'customer and domain incident gates survive resolution and pause future scheduling',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.hot);
    await f.service.handle(f.source);
    const incident = f.event('custody.incident.opened.v1', {
      incidentId: randomUUID(),
      severity: 'critical',
      category: 'unauthorized_outflow',
      status: 'open',
      reason: 'Custody review required',
    });
    await f.service.handle(incident);
    await f.service.handle(f.credit());
    assert.equal((await f.work()).state, 'paused_review');
    if (incident.type !== 'custody.incident.opened.v1') throw new Error('Fixture mismatch');
    await f.service.handle(
      f.event('custody.incident.resolved.v1', { ...incident.data, status: 'resolved' }),
    );
    await f.service.handle(f.credit());
    assert.equal((await f.work()).state, 'paused_review');
    const global = fixture();
    await global.service.handle(
      global.event('custody.incident.opened.v1', incident.data, { customerId: undefined }),
    );
    await global.service.handle(global.hot);
    await global.service.handle(global.source);
    await global.service.handle(global.credit());
    assert.equal((await global.work()).state, 'paused_review');
  },
);

test(
  'a later incompatible source projection pauses already retained credit work',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(f.credit());
    await f.service.handle({ ...f.source, customerId: randomUUID() });
    assert.equal((await f.work()).state, 'paused_registry_identity');
    assert.equal((await f.work()).hot_wallet_id, f.hotWalletId);
  },
);

test(
  'pending deposit observations cannot trigger sweep scheduling',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const observation = f.event('deposit.observed.v1', {
      depositId: randomUUID(),
      walletId: f.walletId,
      asset,
      amount: '20',
      transactionHash: `0x${'a'.repeat(64)}`,
      transferIdentity: { kind: 'evm.native', id: '0' },
    });
    await assert.rejects(f.service.handle(observation), /only accounted deposits/);
    assert.equal(await db!.sweepWork.count({ where: { domain_id: f.domainId } }), 0);
    assert.equal(await db!.inbox.count({ where: { id: observation.eventId } }), 0);
  },
);

test('sweep processor verifies signed envelopes and treats malformed or unsupported actions as nonretryable', async () => {
  const handled: ExchangeEvent[] = [];
  const service = {
    handle: async (value: ExchangeEvent) => {
      handled.push(value);
    },
  } as SweepService;
  const processor = new SweepProcessor(service, auth);
  const event = exchangeEventSchema.parse({
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    domainId: 'sweep-processor',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision: 1,
    customerId: randomUUID(),
    type: 'deposit.credited.v1',
    data: {
      depositId: randomUUID(),
      ledgerBatchId: randomUUID(),
      walletId: randomUUID(),
      asset,
      amount: '1',
    },
  });
  const id = randomUUID();
  await processor.process({ id, name: event.type, data: auth.seal(event, id) } as Job);
  assert.deepEqual(handled, [event]);
  await assert.rejects(
    processor.process({ id, name: event.type, data: {} } as Job),
    UnrecoverableError,
  );
  assert.equal(QUEUES.sweep, 'sweep-actions');
});

test('reversal of all deposits removes actionable planning units', { skip: !enabled }, async () => {
  const f = fixture();
  await f.service.handle(f.hot);
  await f.service.handle(f.source);
  const credit = f.credit('99');
  if (credit.type !== 'deposit.credited.v1') throw new Error('Fixture mismatch');
  await f.service.handle(credit);
  await f.service.handle(
    f.event(
      'deposit.reversed.v1',
      {
        depositId: credit.data.depositId,
        ledgerBatchId: randomUUID(),
        asset,
        amount: '99',
        reason: 'Reorg',
      },
      { revision: 2 },
    ),
  );
  const work = await f.work();
  assert.equal(work.state, 'no_credited_deposits');
  assert.equal(work.observed_credit_units, '0');
  assert.equal(work.credited_deposit_count, 0);
});

test(
  'native Bitcoin and Solana scheduling retain their own registered network and hot wallet identities',
  { skip: !enabled },
  async () => {
    for (const [chain, network] of [
      ['bitcoin', 'regtest'],
      ['solana', 'devnet'],
    ] as const) {
      const f = fixture();
      if (
        f.hot.type !== 'custody-wallet.registry.requested.v1' ||
        f.source.type !== 'customer-wallet.registry.requested.v1'
      )
        throw new Error('Fixture mismatch');
      await f.service.handle({ ...f.hot, data: { ...f.hot.data, chain, network } });
      await f.service.handle({ ...f.source, data: { ...f.source.data, chain, network } });
      const credit = f.credit('100');
      if (credit.type !== 'deposit.credited.v1') throw new Error('Fixture mismatch');
      await f.service.handle({
        ...credit,
        data: { ...credit.data, asset: { chain, network, assetId: `token:${chain}:native` } },
      });
      const work = await f.work();
      assert.equal(work.state, 'blocked_execution_not_implemented');
      assert.equal(work.chain, chain);
      assert.equal(work.network, network);
      assert.equal(work.hot_wallet_id, f.hotWalletId);
    }
  },
);

test(
  'reversal-first custody loss notification pauses future credit work before registry arrives',
  { skip: !enabled },
  async () => {
    const f = fixture();
    await f.service.handle(
      f.event(
        'custody.loss.reverted.v1',
        {
          incidentId: randomUUID(),
          walletId: f.walletId,
          asset,
          amount: '17',
          transactionHash: `0x${'a'.repeat(64)}`,
          reason: 'Custody loss was compensated after a reorg',
        },
        { revision: 2 },
      ),
    );
    await f.service.handle(f.credit('100'));
    await f.service.handle(f.source);
    await f.service.handle(f.hot);
    assert.equal((await f.work()).state, 'paused_review');
    assert.equal((await f.work()).observed_credit_units, '100');
    assert.equal(
      (await db!.sweepCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } })).paused,
      true,
    );
  },
);
