import { acceptanceRollout } from './helpers/rollout-fixture.js';
import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SweepPrismaService } from '../apps/sweep/src/prisma/prisma.service.js';
import { SweepService } from '../apps/sweep/src/sweep/sweep.service.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { migrate } from '../scripts/migrate.js';

const enabled = !!process.env.TEST_SWEEP_DATABASE_URL;
const db = enabled
  ? new SweepPrismaService({ databaseUrl: process.env.TEST_SWEEP_DATABASE_URL! })
  : undefined;
const auth = new MessageAuth('s'.repeat(64), 'sweep-execution-test');
const domains: string[] = [];
const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' } as const;

async function fixture() {
  const domainId = `sweep-execution-${randomUUID()}`;
  domains.push(domainId);
  const customerId = randomUUID(),
    walletId = randomUUID(),
    hotWalletId = randomUUID();
  const service = new SweepService(
    db!,
    auth,
    {
      domainId,
      enableNativeSweeps: true,
      retryDelayMs: 0,
    },
    acceptanceRollout,
  );
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
  await service.handle(
    event(
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
    ),
  );
  await service.handle(
    event('customer-wallet.registry.requested.v1', {
      walletId,
      chain: asset.chain,
      network: asset.network,
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
      hotWalletId,
      account: 10,
      registryRevision: 1,
    }),
  );
  const credit = (amount = '100') =>
    service.handle(
      event('deposit.credited.v1', {
        depositId: randomUUID(),
        ledgerBatchId: randomUUID(),
        walletId,
        asset,
        amount,
      }),
    );
  const work = () => db!.sweepWork.findFirstOrThrow({ where: { domain_id: domainId } });
  const plans = async () => {
    const rows = await db!.outbox.findMany({
      where: { queue: QUEUES.wallet, payload: { path: ['domainId'], equals: domainId } },
      orderBy: { created_at: 'asc' },
    });
    return rows
      .map((row) => exchangeEventSchema.parse(row.payload))
      .filter(
        (e): e is Extract<ExchangeEvent, { type: 'sweep.plan.requested.v1' }> =>
          e.type === 'sweep.plan.requested.v1',
      );
  };
  const start = async () => {
    await credit();
    assert.equal(await service.scheduleEligible(), 1);
    return (await plans()).at(-1)!;
  };
  const response = (
    plan: Awaited<ReturnType<typeof start>>,
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ) =>
    event(type, data, {
      operationId: plan.operationId,
      attemptId: plan.attemptId,
      requestDigest: plan.requestDigest,
      policyVersion: plan.policyVersion,
      aggregateId: plan.operationId,
      ...extra,
    });
  const prepared = (plan: Awaited<ReturnType<typeof start>>, extra: Record<string, unknown> = {}) =>
    response(plan, 'sweep.plan.prepared.v1', {
      sourceWalletId: walletId,
      destinationWalletId: hotWalletId,
      amount: { asset, amount: '73' },
      preparationDigest: 'a'.repeat(64),
      maxFeeUnits: '7',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      ...extra,
    });
  return {
    domainId,
    customerId,
    walletId,
    hotWalletId,
    service,
    event,
    credit,
    work,
    plans,
    start,
    response,
    prepared,
  };
}

before(async () => {
  if (enabled) await migrate(process.env.TEST_SWEEP_DATABASE_URL!, 'sweep');
});
after(async () => {
  if (!enabled) return;
  const where = { domain_id: { in: domains } };
  const operations = await db!.sweepOperation.findMany({ where, select: { id: true } });
  await db!.sweepAttempt.deleteMany({
    where: { operation_id: { in: operations.map((row) => row.id) } },
  });
  await db!.sweepOperation.deleteMany({ where });
  await db!.sweepException.deleteMany({ where });
  await db!.sweepWork.deleteMany({ where });
  await db!.sweepDeposit.deleteMany({ where });
  await db!.sweepWalletRegistration.deleteMany({ where });
  await db!.sweepCustomer.deleteMany({ where });
  await db!.sweepDomainGate.deleteMany({ where });
  await db!.inbox.deleteMany({ where });
  for (const domainId of domains)
    await db!.outbox.deleteMany({ where: { payload: { path: ['domainId'], equals: domainId } } });
  await db!.$disconnect();
});

test(
  'sweep prepares exact chain amount and preserves a later deposit generation until dual terminal proof',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    assert.equal(plan.data.generation, 1);
    await Promise.all([f.service.scheduleEligible(), f.service.scheduleEligible()]);
    assert.equal((await f.plans()).length, 1);
    const prepared = f.prepared(plan);
    await f.service.handle(prepared);
    await f.service.handle(prepared);
    const executes = await db!.outbox.findMany({
      where: {
        payload: { path: ['operationId'], equals: plan.operationId },
        queue: { in: [QUEUES.wallet, QUEUES.ledger, QUEUES.activity] },
      },
    });
    const execution = executes
      .map((row) => exchangeEventSchema.parse(row.payload))
      .filter((row) => row.type === 'sweep.execute.requested.v1');
    assert.equal(execution.length, 3);
    assert.equal(new Set(execution.map((row) => row.eventId)).size, 1);
    assert.equal(execution[0]!.type, 'sweep.execute.requested.v1');
    if (execution[0]!.type !== 'sweep.execute.requested.v1') throw new Error('Fixture mismatch');
    assert.equal(
      execution[0]!.data.amount.amount,
      '73',
      'Credited 100 does not determine spendable chain amount',
    );
    await f.credit('200');
    assert.equal((await f.work()).generation, 2);
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    const hash = `0x${'b'.repeat(64)}`;
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', {
        state: 'confirmed',
        transactionHash: hash,
      }),
    );
    await f.service.handle(
      f.response(plan, 'settlement.committed.v1', {
        ledgerBatchId: randomUUID(),
        transactionHash: hash,
      }),
    );
    assert.equal(
      (await f.work()).active_operation_id,
      plan.operationId,
      'Ledger alone cannot release an execution fence',
    );
    await f.service.handle(
      f.response(
        plan,
        'execution.attempt.updated.v1',
        { state: 'confirmed', transactionHash: hash, terminalSafe: true, settlementRevision: 1 },
        { revision: 2 },
      ),
    );
    assert.equal((await f.work()).active_operation_id, null);
    assert.equal((await f.work()).consumed_generation, 1);
    assert.equal(await f.service.scheduleEligible(), 1);
    const next = (await f.plans()).at(-1)!;
    assert.equal(next.data.generation, 2);
    assert.notEqual(next.operationId, plan.operationId);
    assert.notEqual(next.attemptId, plan.attemptId);
  },
);

test(
  'unsigned deferrals retry with new immutable operation and attempt identities',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(
      f.response(plan, 'sweep.plan.deferred.v1', {
        code: 'minimum_sweep',
        reason: 'Residual is below minimum sweep amount',
        retryAfter: new Date(Date.now() - 1).toISOString(),
      }),
    );
    assert.equal((await f.work()).state, 'deferred');
    assert.equal(await db!.sweepException.count({ where: { domain_id: f.domainId } }), 1);
    assert.equal(await f.service.scheduleEligible(), 1);
    const next = (await f.plans()).at(-1)!;
    assert.notEqual(next.requestDigest, plan.requestDigest);
    await assert.rejects(
      db!.sweepOperation.update({
        where: { id: plan.operationId },
        data: { hot_wallet_id: randomUUID() },
      }),
      /immutable/,
    );
    await assert.rejects(f.service.handle(f.prepared(plan)), /retired operation/);
  },
);

test(
  'review gates between preparation and execution keep claims fenced and emit no execute action',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(
      f.event('custody.incident.opened.v1', {
        incidentId: randomUUID(),
        severity: 'critical',
        category: 'custody_review',
        status: 'open',
        reason: 'Review custody incident before spending',
      }),
    );
    await f.service.handle(f.prepared(plan));
    assert.equal((await f.work()).state, 'paused_review');
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    assert.equal(await f.service.scheduleEligible(), 0);
    assert.equal(
      await db!.outbox.count({
        where: {
          payload: { path: ['type'], equals: 'sweep.execute.requested.v1' },
          AND: { payload: { path: ['domainId'], equals: f.domainId } },
        },
      }),
      0,
    );
  },
);

test(
  'expired preparation and later deferral cannot release a prepared attempt',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(f.prepared(plan, { expiresAt: new Date(Date.now() - 1).toISOString() }));
    assert.equal((await f.work()).state, 'attention');
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    await assert.rejects(
      f.service.handle(
        f.response(plan, 'sweep.plan.deferred.v1', {
          code: 'expired',
          reason: 'Preparation expired',
          retryAfter: new Date().toISOString(),
        }),
      ),
      /terminal proof/,
    );
    assert.equal(await f.service.scheduleEligible(), 0);
  },
);

test(
  'matching unsigned terminal proof releases expired and queued preparations for a fresh retry',
  { skip: !enabled },
  async () => {
    for (const expired of [false, true]) {
      const f = await fixture(),
        plan = await f.start();
      await f.service.handle(
        f.prepared(plan, expired ? { expiresAt: new Date(Date.now() - 1).toISOString() } : {}),
      );
      assert.equal((await f.work()).state, expired ? 'attention' : 'queued');
      const deferred = f.response(plan, 'sweep.plan.deferred.v1', {
        code: 'expired',
        reason: 'Wallet retired the unsigned preparation',
        retryAfter: new Date(Date.now() - 1).toISOString(),
        preparationDigest: 'a'.repeat(64),
        terminalSafe: true,
      });
      await f.service.handle(deferred);
      await f.service.handle(deferred);
      assert.equal((await f.work()).active_operation_id, null);
      assert.equal((await f.work()).state, 'deferred');
      assert.equal(
        (await db!.sweepAttempt.findUniqueOrThrow({ where: { id: plan.attemptId } })).terminal_safe,
        true,
      );
      assert.equal(await f.service.scheduleEligible(), 1);
      const next = (await f.plans()).at(-1)!;
      assert.notEqual(next.operationId, plan.operationId);
      assert.notEqual(next.attemptId, plan.attemptId);
    }
  },
);

test(
  'prepared deferral rejects mismatched proof and remains fenced after a signing or unknown result',
  { skip: !enabled },
  async () => {
    for (const executionState of ['signing', 'attention'] as const) {
      const f = await fixture(),
        plan = await f.start();
      await f.service.handle(f.prepared(plan));
      const deferred = (preparationDigest: string) =>
        f.response(plan, 'sweep.plan.deferred.v1', {
          code: 'expired',
          reason: 'Preparation expired',
          retryAfter: new Date().toISOString(),
          preparationDigest,
          terminalSafe: true,
        });
      await assert.rejects(f.service.handle(deferred('b'.repeat(64))), /terminal proof/);
      await f.service.handle(
        f.response(plan, 'execution.attempt.updated.v1', { state: executionState }),
      );
      await assert.rejects(f.service.handle(deferred('a'.repeat(64))), /terminal proof/);
      assert.equal((await f.work()).active_operation_id, plan.operationId);
      assert.equal(await f.service.scheduleEligible(), 0);
    }
  },
);

test(
  'unsigned preparation release preserves an existing custody review gate',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(
      f.event('custody.incident.opened.v1', {
        incidentId: randomUUID(),
        severity: 'critical',
        category: 'custody_review',
        status: 'open',
        reason: 'Custody review is required',
      }),
    );
    await f.service.handle(f.prepared(plan));
    await f.service.handle(
      f.response(plan, 'sweep.plan.deferred.v1', {
        code: 'expired',
        reason: 'Unsigned preparation expired',
        retryAfter: new Date(Date.now() - 1).toISOString(),
        preparationDigest: 'a'.repeat(64),
        terminalSafe: true,
      }),
    );
    assert.equal((await f.work()).active_operation_id, null);
    assert.equal((await f.work()).state, 'paused_review');
    assert.equal(await f.service.scheduleEligible(), 0);
  },
);

test(
  'a delayed reversal older than a newer settlement cannot reopen or pause the operation',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    const hash = `0x${'d'.repeat(64)}`;
    await f.service.handle(f.prepared(plan));
    await f.service.handle(
      f.response(
        plan,
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: hash },
        { revision: 3 },
      ),
    );
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', {
        state: 'confirmed',
        transactionHash: hash,
        terminalSafe: true,
        settlementRevision: 3,
      }),
    );
    assert.equal((await f.work()).active_operation_id, null);
    const settled = await db!.sweepOperation.findUniqueOrThrow({ where: { id: plan.operationId } });
    const reversed = f.response(
      plan,
      'settlement.reversed.v1',
      { ledgerBatchId: randomUUID(), priorSettlementRevision: 1 },
      { revision: 2 },
    );
    await f.service.handle(reversed);
    await f.service.handle(reversed);
    assert.deepEqual(
      await db!.sweepOperation.findUniqueOrThrow({ where: { id: plan.operationId } }),
      settled,
    );
    assert.equal((await f.work()).active_operation_id, null);
    assert.equal((await f.work()).state, 'settled_residual');
    assert.equal(
      (await db!.sweepCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } })).paused,
      false,
    );
    assert.equal(await f.service.scheduleEligible(), 1);
  },
);

test(
  'an old terminal proof cannot release a newer settlement until matching revision proof arrives',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    const hash = `0x${'e'.repeat(64)}`;
    await f.service.handle(f.prepared(plan));
    await f.service.handle(
      f.response(
        plan,
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: hash },
        { revision: 3 },
      ),
    );
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', {
        state: 'confirmed',
        transactionHash: hash,
        terminalSafe: true,
        settlementRevision: 1,
      }),
    );
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    assert.equal(await f.service.scheduleEligible(), 0);
    assert.equal(
      (await db!.sweepAttempt.findUniqueOrThrow({ where: { id: plan.attemptId } }))
        .terminal_settlement_revision,
      1,
    );
    await f.service.handle(
      f.response(
        plan,
        'execution.attempt.updated.v1',
        { state: 'confirmed', transactionHash: hash, terminalSafe: true, settlementRevision: 3 },
        { revision: 2 },
      ),
    );
    assert.equal((await f.work()).active_operation_id, null);
    assert.equal(await f.service.scheduleEligible(), 1);
  },
);

test(
  'canonical terminal proof requires both its hash and positive settlement revision',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(f.prepared(plan));
    for (const incomplete of [
      { state: 'confirmed', terminalSafe: true },
      { state: 'confirmed', terminalSafe: true, transactionHash: `0x${'f'.repeat(64)}` },
      { state: 'confirmed', terminalSafe: true, settlementRevision: 1 },
    ])
      await assert.rejects(
        f.service.handle(f.response(plan, 'execution.attempt.updated.v1', incomplete)),
        /canonical hash and settlement revision/,
      );
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    assert.equal(
      (await db!.sweepAttempt.findUniqueOrThrow({ where: { id: plan.attemptId } }))
        .terminal_settlement_revision,
      null,
    );
    await assert.rejects(
      db!.sweepAttempt.update({
        where: { id: plan.attemptId },
        data: { terminal_settlement_revision: 0 },
      }),
      /terminal_settlement_revision/,
    );
  },
);

test(
  'reversal clears a persisted terminal proof and requires fresh proof after re-inclusion',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    const hash = `0x${'9'.repeat(64)}`;
    await f.service.handle(f.prepared(plan));
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', {
        state: 'confirmed',
        transactionHash: hash,
        terminalSafe: true,
        settlementRevision: 1,
      }),
    );
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    assert.equal(
      (await db!.sweepAttempt.findUniqueOrThrow({ where: { id: plan.attemptId } }))
        .terminal_settlement_revision,
      1,
    );
    await f.service.handle(
      f.response(
        plan,
        'settlement.reversed.v1',
        { ledgerBatchId: randomUUID(), priorSettlementRevision: 1 },
        { revision: 2 },
      ),
    );
    const reversedAttempt = await db!.sweepAttempt.findUniqueOrThrow({
      where: { id: plan.attemptId },
    });
    assert.equal(reversedAttempt.terminal_safe, false);
    assert.equal(reversedAttempt.terminal_settlement_revision, null);
    await f.service.handle(
      f.response(
        plan,
        'settlement.committed.v1',
        { ledgerBatchId: randomUUID(), transactionHash: hash },
        { revision: 3 },
      ),
    );
    assert.equal((await f.work()).active_operation_id, plan.operationId);
    await f.service.handle(
      f.response(
        plan,
        'execution.attempt.updated.v1',
        { state: 'confirmed', transactionHash: hash, terminalSafe: true, settlementRevision: 3 },
        { revision: 2 },
      ),
    );
    assert.equal((await f.work()).active_operation_id, null);
    assert.equal((await f.work()).state, 'paused_review');
    assert.equal(await f.service.scheduleEligible(), 0);
  },
);

test(
  'reversal first delivery suppresses stale commit and terminal status and creates sticky review',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    await f.service.handle(f.prepared(plan));
    await f.service.handle(
      f.response(
        plan,
        'settlement.reversed.v1',
        { ledgerBatchId: randomUUID(), priorSettlementRevision: 1 },
        { revision: 2 },
      ),
    );
    await f.service.handle(
      f.response(plan, 'settlement.committed.v1', {
        ledgerBatchId: randomUUID(),
        transactionHash: `0x${'c'.repeat(64)}`,
      }),
    );
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', {
        state: 'confirmed',
        transactionHash: `0x${'c'.repeat(64)}`,
        terminalSafe: true,
        settlementRevision: 1,
      }),
    );
    const work = await f.work();
    assert.equal(work.active_operation_id, plan.operationId);
    assert.equal(work.state, 'paused_review');
    assert.equal(
      (await db!.sweepCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } })).paused,
      true,
    );
    assert.equal(await f.service.scheduleEligible(), 0);
    assert.equal(
      (await db!.sweepAttempt.findUniqueOrThrow({ where: { id: plan.attemptId } }))
        .terminal_settlement_revision,
      null,
    );
  },
);

test(
  'changed preparation, request digest and execution revision are rejected without extra execution',
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      plan = await f.start();
    const prepared = f.prepared(plan);
    await f.service.handle(prepared);
    await assert.rejects(
      f.service.handle({ ...prepared, eventId: randomUUID(), requestDigest: '0'.repeat(64) }),
      /identity mismatch/,
    );
    await assert.rejects(
      f.service.handle(f.prepared(plan, { preparationDigest: 'b'.repeat(64) })),
      /identity changed/,
    );
    await assert.rejects(
      db!.sweepAttempt.update({ where: { id: plan.attemptId }, data: { amount: '74' } }),
      /immutable/,
    );
    await f.service.handle(
      f.response(plan, 'execution.attempt.updated.v1', { state: 'submitted' }),
    );
    await assert.rejects(
      f.service.handle(f.response(plan, 'execution.attempt.updated.v1', { state: 'failed' })),
      /revision content changed/,
    );
  },
);

test(
  'unsupported token sweep work records exceptions and never automatically funds native principal',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.service.handle(
      f.event('deposit.credited.v1', {
        depositId: randomUUID(),
        ledgerBatchId: randomUUID(),
        walletId: f.walletId,
        asset: { ...asset, assetId: `token:ethereum:erc20:0x${'a'.repeat(40)}` },
        amount: '100',
      }),
    );
    assert.equal((await f.work()).state, 'deferred_unsupported_asset');
    assert.equal(await f.service.scheduleEligible(), 0);
    assert.equal(
      await db!.sweepException.count({
        where: { domain_id: f.domainId, category: 'unsupported_asset' },
      }),
      1,
    );
    assert.equal(await db!.sweepFundingIntent.count({ where: { domain_id: f.domainId } }), 0);
  },
);

test(
  'periodic reconciliation repairs disabled-era work and respects persisted retry times',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const disabled = new SweepService(db!, auth, { domainId: f.domainId }, acceptanceRollout);
    await disabled.handle(
      f.event('deposit.credited.v1', {
        depositId: randomUUID(),
        ledgerBatchId: randomUUID(),
        walletId: f.walletId,
        asset,
        amount: '100',
      }),
    );
    assert.equal((await f.work()).state, 'blocked_execution_not_implemented');
    assert.equal(await disabled.scheduleEligible(), 0);
    assert.equal(await f.service.scheduleEligible(1), 1);
    const plan = (await f.plans()).at(-1)!;
    await f.service.handle(
      f.response(plan, 'sweep.plan.deferred.v1', {
        code: 'rpc_retry',
        reason: 'Canonical RPC temporarily unavailable',
        retryAfter: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    assert.equal(await f.service.scheduleEligible(), 0);
    assert.equal((await f.plans()).length, 1);
    await db!.sweepWork.update({
      where: { id: (await f.work()).id },
      data: { next_attempt_at: new Date(Date.now() - 1) },
    });
    assert.equal(await f.service.scheduleEligible(), 1);
    const next = (await f.plans()).at(-1)!;
    assert.equal(
      (await db!.sweepOperation.findUniqueOrThrow({ where: { id: next.operationId } }))
        .supersedes_operation_id,
      plan.operationId,
    );
  },
);

test(
  'accounted token work blocks native drain, duplicate credits preserve the dependency and reversal resumes scheduling',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const token = { ...asset, assetId: 'token:ethereum:erc20:0x' + 'ab'.repeat(20) };
    const credit = f.event('deposit.credited.v1', {
      depositId: randomUUID(),
      ledgerBatchId: randomUUID(),
      walletId: f.walletId,
      asset: token,
      amount: '500',
    });
    await f.service.handle(credit);
    await f.service.handle(credit);
    await f.credit();
    assert.equal(await f.service.scheduleEligible(), 0);
    const nativeWork = await db!.sweepWork.findFirstOrThrow({
      where: { domain_id: f.domainId, asset_id: asset.assetId },
    });
    assert.equal(nativeWork.state, 'waiting_token_sweeps');
    assert.equal((await f.plans()).length, 0);
    assert.equal(credit.type, 'deposit.credited.v1');
    if (credit.type !== 'deposit.credited.v1') return;
    await f.service.handle(
      f.event(
        'deposit.reversed.v1',
        {
          depositId: credit.data.depositId,
          ledgerBatchId: randomUUID(),
          asset: token,
          amount: '500',
          reason: 'canonical reversal',
        },
        { revision: 2 },
      ),
    );
    assert.equal(await f.service.scheduleEligible(), 1);
    assert.equal((await f.plans()).length, 1);
  },
);
