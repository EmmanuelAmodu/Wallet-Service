import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { SettlementsService } from '../apps/ledger/src/settlements/settlements.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { LedgerExchangeModule } from '../apps/ledger/src/exchange/exchange.module.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ledgerConfig } from '../apps/ledger/src/config/ledger.config.js';
import { SweepPrismaService } from '../apps/sweep/src/prisma/prisma.service.js';
import { SweepService } from '../apps/sweep/src/sweep/sweep.service.js';
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../packages/queue/src/exchange-contracts.js';
import { queueConfig } from '../packages/queue/src/queue.config.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';
import { migrate } from '../scripts/migrate.js';

const databaseUrl = process.env.TEST_LEDGER_DATABASE_URL;
const db = databaseUrl ? new LedgerPrismaService({ databaseUrl }) : undefined;
const config = { resetEpoch: 'exchange-settlements-test' };
const journal = new JournalService(new AccountsService());
const registry = db ? new ExchangeRegistryService(db) : undefined;
const deposits = db ? new DepositsService(db, journal, config) : undefined;
const reservations = db ? new ReservationsService(db, journal, config) : undefined;
const settlements = db ? new SettlementsService(db, journal, reservations!) : undefined;
const sweepDatabaseUrl = process.env.TEST_SWEEP_DATABASE_URL;
const sweepDb = sweepDatabaseUrl
  ? new SweepPrismaService({ databaseUrl: sweepDatabaseUrl })
  : undefined;
const domains = new Set<string>();
const native: CanonicalAsset = {
  chain: 'ethereum',
  network: '11155111',
  assetId: 'token:ethereum:native',
};
const token: CanonicalAsset = { ...native, assetId: 'token:ethereum:erc20:0x' + 'ab'.repeat(20) };
before(async () => {
  if (databaseUrl) await migrate(databaseUrl, 'ledger');
  if (sweepDatabaseUrl) await migrate(sweepDatabaseUrl, 'sweep');
});
after(async () => {
  for (const domainId of domains) {
    await db?.outbox.deleteMany({ where: { payload: { path: ['domainId'], equals: domainId } } });
    const where = { domain_id: domainId };
    await sweepDb?.sweepWork.deleteMany({ where });
    await sweepDb?.sweepDeposit.deleteMany({ where });
    await sweepDb?.sweepWalletRegistration.deleteMany({ where });
    await sweepDb?.sweepCustomer.deleteMany({ where });
    await sweepDb?.sweepDomainGate.deleteMany({ where });
    await sweepDb?.inbox.deleteMany({ where });
  }
  await sweepDb?.$disconnect();
  await db?.$disconnect();
});

function base(domainId: string, revision = 1) {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    resetEpoch: config.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId,
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: domainId,
    revision,
  };
}

async function fixture() {
  const domainId = `settlement-${randomUUID()}`;
  domains.add(domainId);
  const customerId = randomUUID(),
    hotId = randomUUID(),
    walletId = randomUUID(),
    managementId = randomUUID();
  const address = () => '0x' + randomUUID().replaceAll('-', '').padEnd(40, '0');
  for (const [wallet, role, account] of [
    [hotId, 'hot', 0],
    [managementId, 'management', 1],
  ] as const)
    await registry!.handle(
      exchangeEventSchema.parse({
        ...base(domainId),
        type: 'custody-wallet.registry.requested.v1',
        data: {
          walletId: wallet,
          chain: native.chain,
          network: native.network,
          address: address(),
          role,
          account,
          registryRevision: 1,
        },
      }),
    );
  await registry!.handle(
    exchangeEventSchema.parse({
      ...base(domainId),
      type: 'customer-wallet.registry.requested.v1',
      customerId,
      data: {
        walletId,
        hotWalletId: hotId,
        chain: native.chain,
        network: native.network,
        address: address(),
        account: 10,
        registryRevision: 1,
      },
    }),
  );
  const credit = async (amount: string, asset = native) => {
    const hash = '0x' + createHash('sha256').update(randomUUID()).digest('hex');
    await deposits!.handle(
      exchangeEventSchema.parse({
        ...base(domainId),
        type: 'deposit.finalized.v1',
        customerId,
        data: {
          depositId: randomUUID(),
          walletId,
          asset,
          amount,
          transferIdentity: { kind: 'evm.native', id: `${hash}:0` },
          transactionHash: hash,
          blockHash: '0x' + 'cd'.repeat(32),
        },
      }),
    );
  };
  const spec = (type: AccountSpec['type'], ownerId: string, asset = native): AccountSpec => ({
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
    normalSide: type.startsWith('customer_') || type === 'fee_revenue' ? 'credit' : 'debit',
  });
  const balance = (type: AccountSpec['type'], ownerId: string, asset = native) =>
    db!.$transaction((tx) => journal.balance(tx, spec(type, ownerId, asset)));
  const execute = async (type: 'sweep' | 'funding', amount: string, asset = native, fees = '0') => {
    const event = exchangeEventSchema.parse({
      ...base(domainId),
      type: `${type}.execute.requested.v1`,
      operationId: randomUUID(),
      attemptId: randomUUID(),
      requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      data: {
        sourceWalletId: type === 'sweep' ? walletId : managementId,
        destinationWalletId: type === 'sweep' ? hotId : walletId,
        amount: { asset, amount },
      },
    });
    await settlements!.handle(event);
    await settlements!.handle(settlement(event, 'confirmed', fees));
    return event;
  };
  const reserve = async (
    amount = '200',
    fee?: { asset: CanonicalAsset; amount: string },
    recordExecution = true,
  ) => {
    const grouped = new Map<string, { asset: CanonicalAsset; amount: string }>();
    for (const value of [{ asset: native, amount }, ...(fee ? [fee] : [])]) {
      const key = value.asset.assetId;
      grouped.set(key, {
        asset: value.asset,
        amount: (BigInt(grouped.get(key)?.amount ?? '0') + BigInt(value.amount)).toString(),
      });
    }
    const event = exchangeEventSchema.parse({
      ...base(domainId),
      type: 'withdrawal.reserve.requested.v1',
      customerId,
      operationId: randomUUID(),
      requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      policyVersion: 'exchange-financial-v1',
      data: {
        amounts: [...grouped.values()],
        principal: { asset: native, amount },
        ...(fee ? { customerFee: fee } : {}),
        hotWalletId: hotId,
        destination: '0x' + 'ef'.repeat(20),
        quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
      },
    });
    await reservations!.handle(event);
    const row = await db!.withdrawalReservation.findUniqueOrThrow({
      where: { operation_id: event.operationId! },
    });
    assert.equal(row.state, 'held');
    const execution = exchangeEventSchema.parse({
      ...base(domainId),
      type: 'withdrawal.execute.requested.v1',
      customerId,
      operationId: event.operationId,
      attemptId: randomUUID(),
      requestDigest: event.requestDigest,
      data: {
        sourceWalletId: hotId,
        destination: '0x' + 'ef'.repeat(20),
        amount: { asset: native, amount },
      },
    });
    if (recordExecution) await settlements!.handle(execution);
    return { event, execution, reservation: row };
  };
  return {
    domainId,
    customerId,
    hotId,
    walletId,
    managementId,
    credit,
    balance,
    execute,
    reserve,
    spec,
  };
}

function reversal(execution: ExchangeEvent, revision = 2, priorSettlementRevision = 1) {
  return exchangeEventSchema.parse({
    ...base(execution.domainId, revision),
    type: 'settlement.reverted.v1',
    operationId: execution.operationId,
    attemptId: execution.attemptId,
    requestDigest: execution.requestDigest,
    ...(execution.customerId ? { customerId: execution.customerId } : {}),
    data: { priorSettlementRevision, reason: 'canonical block disappeared' },
  });
}

function settlement(
  execution: ExchangeEvent,
  outcome: 'confirmed' | 'failed',
  fee: string,
  revision = 1,
): Extract<ExchangeEvent, { type: 'settlement.requested.v1' }> {
  return exchangeEventSchema.parse({
    ...base(execution.domainId, revision),
    type: 'settlement.requested.v1',
    operationId: execution.operationId,
    attemptId: execution.attemptId,
    requestDigest: execution.requestDigest,
    ...(execution.customerId ? { customerId: execution.customerId } : {}),
    data: {
      outcome,
      transactionHash: '0x' + createHash('sha256').update(execution.attemptId!).digest('hex'),
      actualFees: fee === '0' ? [] : [{ asset: native, amount: fee }],
    },
  }) as Extract<ExchangeEvent, { type: 'settlement.requested.v1' }>;
}

test(
  'exchange flow credits once, sweeps custody only and settles hot principal, accepted fee and actual expense once',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('1000');
    await f.execute('sweep', '900', native, '10');
    assert.equal(await f.balance('customer_available', f.customerId), 1000n);
    assert.equal(await f.balance('custody_hot', f.hotId), 900n);
    assert.equal(await f.balance('custody_deposit', f.walletId), 90n);
    const { execution } = await f.reserve('200', { asset: native, amount: '5' });
    const event = settlement(execution, 'confirmed', '3');
    await settlements!.handle(event);
    await settlements!.handle(event);
    await settlements!.handle({ ...event, eventId: randomUUID(), revision: 2 });
    assert.equal(await f.balance('customer_available', f.customerId), 795n);
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 697n);
    assert.equal(await f.balance('fee_revenue', f.domainId), 5n);
    assert.equal(await f.balance('fee_expense', f.domainId), 13n);
    assert.equal(
      await db!.journalBatch.count({
        where: { domain_id: f.domainId, kind: 'settlement', operation_id: execution.operationId },
      }),
      1,
    );
    await assert.rejects(
      settlements!.handle({
        ...event,
        eventId: randomUUID(),
        revision: 3,
        data: { ...event.data, actualFees: [{ asset: native, amount: '4' }] },
      }),
      /cannot change/,
    );
  },
);

test(
  'definitively failed withdrawal releases principal and separate-asset fee but records the paid native fee',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('300');
    await f.credit('50', token);
    await f.execute('sweep', '250');
    const { execution } = await f.reserve('100', { asset: token, amount: '7' });
    await settlements!.handle(settlement(execution, 'failed', '4'));
    assert.equal(await f.balance('customer_available', f.customerId), 300n);
    assert.equal(await f.balance('customer_available', f.customerId, token), 50n);
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('customer_reserved', f.customerId, token), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 246n);
    assert.equal(await f.balance('fee_revenue', f.domainId, token), 0n);
    assert.equal(await f.balance('fee_expense', f.domainId), 4n);
  },
);

test(
  'signed or uncertain execution keeps its reservation despite cancellation requests',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('500');
    const { event, execution, reservation } = await f.reserve('100');
    await settlements!.handle(
      exchangeEventSchema.parse({
        ...base(f.domainId, 2),
        type: 'execution.attempt.updated.v1',
        operationId: execution.operationId,
        attemptId: execution.attemptId,
        requestDigest: execution.requestDigest,
        data: { state: 'signed' },
      }),
    );
    await reservations!.handle(
      exchangeEventSchema.parse({
        ...base(f.domainId, 3),
        type: 'reservation.release.requested.v1',
        customerId: f.customerId,
        operationId: event.operationId,
        requestDigest: event.requestDigest,
        data: { reservationId: reservation.id, reason: 'client cancelled' },
      }),
    );
    assert.equal(await f.balance('customer_reserved', f.customerId), 100n);
    assert.equal(
      (await db!.withdrawalReservation.findUniqueOrThrow({ where: { id: reservation.id } })).state,
      'held',
    );
  },
);

test(
  'outgoing reorg restores the same hold and custody without allowing an old or duplicate settlement to consume it twice',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('1000');
    await f.execute('sweep', '900');
    const { execution, reservation } = await f.reserve('200');
    const paid = settlement(execution, 'confirmed', '3');
    await settlements!.handle(paid);
    const revert = exchangeEventSchema.parse({
      ...base(f.domainId, 2),
      type: 'settlement.reverted.v1',
      operationId: execution.operationId,
      attemptId: execution.attemptId,
      requestDigest: execution.requestDigest,
      data: { priorSettlementRevision: 1, reason: 'canonical block disappeared' },
    });
    await settlements!.handle(revert);
    await settlements!.handle(revert);
    await settlements!.handle({ ...paid, eventId: randomUUID() });
    assert.equal(await f.balance('customer_reserved', f.customerId), 200n);
    assert.equal(await f.balance('custody_hot', f.hotId), 900n);
    assert.equal(
      (await db!.withdrawalReservation.findUniqueOrThrow({ where: { id: reservation.id } })).state,
      'held',
    );
    const final = { ...paid, eventId: randomUUID(), revision: 3 };
    await settlements!.handle(final);
    await settlements!.handle(final);
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 697n);
  },
);

test(
  'reversal before settlement durably fences stale accounting and allows only a newer matching re-inclusion',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('1000');
    await f.execute('sweep', '900');
    const { execution, reservation } = await f.reserve('200');
    const orphaned = settlement(execution, 'confirmed', '3');
    const reverted = reversal(execution);
    await settlements!.handle(reverted);
    await settlements!.handle(reverted);
    await settlements!.handle({ ...reverted, eventId: randomUUID() });
    await settlements!.handle(orphaned);
    await settlements!.handle({ ...orphaned, eventId: randomUUID() });
    assert.equal(await f.balance('customer_reserved', f.customerId), 200n);
    assert.equal(await f.balance('custody_hot', f.hotId), 900n);
    assert.equal(await f.balance('fee_expense', f.domainId), 0n);
    assert.equal(
      await db!.journalBatch.count({ where: { operation_id: execution.operationId } }),
      1,
      'Only the original withdrawal reservation has posted',
    );
    assert.equal(
      (await db!.exchangeOperation.findUniqueOrThrow({ where: { id: execution.operationId! } }))
        .state,
      'reverted',
    );
    assert.equal(
      await db!.settlementReversal.count({ where: { operation_id: execution.operationId } }),
      1,
    );
    await assert.rejects(
      settlements!.handle({
        ...orphaned,
        eventId: randomUUID(),
        data: { ...orphaned.data, actualFees: [{ asset: native, amount: '4' }] },
      }),
      /conflicting content/,
    );
    await assert.rejects(
      settlements!.handle({
        ...reverted,
        eventId: randomUUID(),
        data: { ...reverted.data, reason: 'changed reversal evidence' },
      } as ExchangeEvent),
      /conflicting content/,
    );
    await assert.rejects(
      settlements!.handle({ ...reverted, eventId: randomUUID(), attemptId: randomUUID() }),
      /identity is immutable/,
    );
    await assert.rejects(
      settlements!.handle({
        ...orphaned,
        eventId: randomUUID(),
        revision: 3,
        data: { ...orphaned.data, transactionHash: '0x' + 'ad'.repeat(32) },
      }),
      /different transaction/,
    );
    const reincluded = {
      ...orphaned,
      eventId: randomUUID(),
      revision: 3,
      data: { ...orphaned.data, actualFees: [{ asset: native, amount: '4' }] },
    };
    await settlements!.handle(reincluded);
    await settlements!.handle(reincluded);
    await settlements!.handle({ ...reverted, eventId: randomUUID() });
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 696n);
    assert.equal(await f.balance('fee_expense', f.domainId), 4n);
    assert.equal(
      (await db!.withdrawalReservation.findUniqueOrThrow({ where: { id: reservation.id } })).state,
      'settled',
    );
  },
);

test(
  'reversal before execution intent survives restart and prevents a delayed cancellation from releasing its hold',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('1000');
    await f.execute('sweep', '900');
    const { event, execution, reservation } = await f.reserve('200', undefined, false);
    const reverted = reversal(execution);
    await settlements!.handle(reverted);
    assert.equal(await db!.exchangeOperation.count({ where: { id: execution.operationId } }), 0);
    assert.equal(await db!.exchangeInbox.count({ where: { event_id: reverted.eventId } }), 1);
    await reservations!.handle(
      exchangeEventSchema.parse({
        ...base(f.domainId, 2),
        type: 'reservation.release.requested.v1',
        operationId: event.operationId,
        requestDigest: event.requestDigest,
        customerId: f.customerId,
        data: { reservationId: reservation.id, reason: 'execution intent is delayed' },
      }),
    );
    assert.equal(await f.balance('customer_reserved', f.customerId), 200n);
    assert.equal(
      (await db!.withdrawalReservation.findUniqueOrThrow({ where: { id: reservation.id } })).state,
      'held',
    );
    const restarted = new SettlementsService(db!, journal, reservations!);
    await assert.rejects(
      restarted.handle({ ...execution, eventId: randomUUID(), requestDigest: 'ab'.repeat(32) }),
      /identity is immutable/,
    );
    await restarted.handle(execution);
    await restarted.handle(reverted);
    await restarted.handle(settlement(execution, 'confirmed', '3'));
    assert.equal(await f.balance('customer_reserved', f.customerId), 200n);
    assert.equal(await f.balance('custody_hot', f.hotId), 900n);
    await restarted.handle(settlement(execution, 'confirmed', '3', 3));
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 697n);
  },
);

test(
  'reversal fence, compensation and both incident deliveries roll back together on a crash and recover once',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('1000');
    await f.execute('sweep', '900');
    const { execution } = await f.reserve('200');
    await settlements!.handle(settlement(execution, 'confirmed', '3'));
    const reverted = reversal(execution);
    const originalPost = journal.post.bind(journal);
    journal.post = async (tx, request) => {
      const batch = await originalPost(tx, request);
      if (request.kind === 'settlement_reversal') throw new Error('crash after compensation');
      return batch;
    };
    try {
      await assert.rejects(settlements!.handle(reverted), /crash after compensation/);
    } finally {
      journal.post = originalPost;
    }
    assert.equal(await f.balance('customer_reserved', f.customerId), 0n);
    assert.equal(await f.balance('custody_hot', f.hotId), 697n);
    assert.equal(
      await db!.settlementReversal.count({ where: { operation_id: execution.operationId } }),
      0,
    );
    assert.equal(await db!.exchangeInbox.count({ where: { event_id: reverted.eventId } }), 0);
    await settlements!.handle(reverted);
    await settlements!.handle(reverted);
    assert.equal(await f.balance('customer_reserved', f.customerId), 200n);
    assert.equal(await f.balance('custody_hot', f.hotId), 900n);
    assert.equal(
      await db!.journalBatch.count({
        where: { operation_id: execution.operationId, kind: 'settlement_reversal' },
      }),
      1,
    );
  },
);

test(
  'settlement fee, custody-shortfall and reorg incidents independently pause Sweep before registry with identical durable deliveries',
  { skip: !db || !sweepDb },
  async () => {
    for (const cause of ['fee', 'shortfall', 'reorg'] as const) {
      const f = await fixture();
      await f.credit('100000000000000000');
      if (cause !== 'shortfall') await f.execute('sweep', '90000000000000000');
      const { execution } = await f.reserve('200');
      const paid = settlement(execution, 'confirmed', cause === 'fee' ? '5000000000000001' : '3');
      await settlements!.handle(paid);
      if (cause === 'reorg') await settlements!.handle(reversal(execution));
      await settlements!.handle(paid);
      const incident = await db!.ledgerIncident.findFirstOrThrow({
        where: { domain_id: f.domainId, operation_id: execution.operationId },
      });
      const deliveries = await db!.outbox.findMany({
        where: { payload: { path: ['data', 'incidentId'], equals: incident.id } },
      });
      assert.equal(deliveries.length, 2);
      assert.deepEqual(
        new Set(deliveries.map((row) => row.queue)),
        new Set([QUEUES.wallet, QUEUES.sweep]),
      );
      assert.deepEqual(deliveries[0].payload, deliveries[1].payload);
      const event = exchangeEventSchema.parse(deliveries[0].payload);
      assert.equal(event.customerId, f.customerId);
      const sweep = new SweepService(sweepDb!, new MessageAuth('s'.repeat(64), config.resetEpoch), {
        domainId: f.domainId,
      });
      await sweep.handle(event);
      await sweep.handle(event);
      assert.equal(
        (await sweepDb!.sweepCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } }))
          .paused,
        true,
      );
      const hot = await db!.exchangeWallet.findUniqueOrThrow({ where: { wallet_id: f.hotId } });
      const source = await db!.exchangeWallet.findUniqueOrThrow({
        where: { wallet_id: f.walletId },
      });
      await sweep.handle(
        exchangeEventSchema.parse({
          ...base(f.domainId),
          type: 'custody-wallet.registry.requested.v1',
          data: {
            walletId: hot.wallet_id,
            chain: hot.chain,
            network: hot.network,
            address: hot.address,
            role: 'hot',
            account: 0,
            registryRevision: 1,
          },
        }),
      );
      await sweep.handle(
        exchangeEventSchema.parse({
          ...base(f.domainId),
          type: 'customer-wallet.registry.requested.v1',
          customerId: f.customerId,
          data: {
            walletId: source.wallet_id,
            hotWalletId: f.hotId,
            chain: source.chain,
            network: source.network,
            address: source.address,
            account: 10,
            registryRevision: 1,
          },
        }),
      );
      const credit = await db!.outbox.findFirstOrThrow({
        where: {
          queue: QUEUES.sweep,
          payload: { path: ['domainId'], equals: f.domainId },
          AND: { payload: { path: ['type'], equals: 'deposit.credited.v1' } },
        },
      });
      await sweep.handle(exchangeEventSchema.parse(credit.payload));
      const work = await sweepDb!.sweepWork.findFirstOrThrow({ where: { domain_id: f.domainId } });
      assert.equal(work.state, 'paused_review');
    }
  },
);

test(
  'management funding and in-transit custody never create customer spendable liability or hot liquidity',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('500');
    await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId: f.domainId,
        revision: 1,
        kind: 'explicit-test-fixture',
        postings: [
          { account: f.spec('custody_management', f.managementId), side: 'debit', amount: 30n },
          {
            account: { ...f.spec('equity', f.domainId), normalSide: 'credit' },
            side: 'credit',
            amount: 30n,
          },
        ],
      }),
    );
    await f.execute('funding', '20', native, '2');
    assert.equal(await f.balance('customer_available', f.customerId), 500n);
    assert.equal(await f.balance('custody_deposit', f.walletId), 520n);
    assert.equal(await f.balance('custody_management', f.managementId), 8n);
    assert.equal(await f.balance('custody_hot', f.hotId), 0n);
    await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId: f.domainId,
        revision: 1,
        kind: 'explicit-test-in-transit',
        postings: [
          { account: f.spec('custody_deposit', f.walletId), side: 'credit', amount: 100n },
          { account: f.spec('custody_in_transit', f.walletId), side: 'debit', amount: 100n },
        ],
      }),
    );
    assert.equal(await f.balance('custody_hot', f.hotId), 0n);
  },
);

test(
  'a reorg of a failed withdrawal restores the hold and freezes a deficit when released funds are already reserved elsewhere',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('500');
    await f.credit('50', token);
    await f.execute('sweep', '400');
    const first = await f.reserve('100');
    await settlements!.handle(settlement(first.execution, 'failed', '2'));
    await f.reserve('480');
    await settlements!.handle(
      exchangeEventSchema.parse({
        ...base(f.domainId, 2),
        type: 'settlement.reverted.v1',
        operationId: first.execution.operationId,
        attemptId: first.execution.attemptId,
        requestDigest: first.execution.requestDigest,
        data: {
          priorSettlementRevision: 1,
          reason: 'failed transaction lost canonical settlement',
        },
      }),
    );
    assert.equal(await f.balance('customer_available', f.customerId), 0n);
    assert.equal(await f.balance('customer_reserved', f.customerId), 580n);
    assert.equal(await f.balance('deficit', f.customerId), 80n);
    assert.equal(await f.balance('customer_frozen', f.customerId, token), 50n);
    assert.equal(
      (await db!.exchangeCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } }))
        .state,
      'frozen',
    );
  },
);

test(
  'recorded execution intent retains the hold before a delayed signing observation arrives',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('500');
    const { event, reservation } = await f.reserve('100');
    await reservations!.handle(
      exchangeEventSchema.parse({
        ...base(f.domainId, 2),
        type: 'reservation.release.requested.v1',
        operationId: event.operationId,
        requestDigest: event.requestDigest,
        customerId: f.customerId,
        data: { reservationId: reservation.id, reason: 'signing status has not arrived' },
      }),
    );
    assert.equal(await f.balance('customer_reserved', f.customerId), 100n);
    assert.equal(
      (await db!.withdrawalReservation.findUniqueOrThrow({ where: { id: reservation.id } })).state,
      'held',
    );
  },
);

test(
  'actual fees above the development policy are recorded once with a durable incident',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('100000000000000000');
    await f.execute('sweep', '90000000000000000');
    const { execution } = await f.reserve('100');
    const paid = settlement(execution, 'confirmed', '5000000000000001');
    await settlements!.handle(paid);
    await settlements!.handle(paid);
    assert.equal(await f.balance('fee_expense', f.domainId), 5000000000000001n);
    assert.equal(
      await db!.ledgerIncident.count({
        where: {
          operation_id: execution.operationId,
          reason: { contains: 'exchange-financial-v1' },
        },
      }),
      1,
    );
  },
);

@Global()
@Module({
  providers: [
    { provide: queueConfig.KEY, useValue: config },
    { provide: ledgerConfig.KEY, useValue: { databaseUrl, apiKey: 'c'.repeat(64) } },
  ],
  exports: [queueConfig.KEY, ledgerConfig.KEY],
})
class ExchangeTestConfig {}

test(
  'Ledger exchange HTTP boundary authenticates customer balance reads and rejects cross-domain and malformed requests',
  { skip: !db },
  async () => {
    const f = await fixture();
    await f.credit('123456789012345678901');
    const module = await Test.createTestingModule({
      imports: [ExchangeTestConfig, LedgerExchangeModule],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new SafeErrorsFilter());
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const path = `/internal/exchange/customers/${f.customerId}/balances?domainId=${f.domainId}`;
    try {
      assert.equal((await fetch(url + path)).status, 401);
      const response = await fetch(url + path, {
        headers: { authorization: 'Bearer ' + 'c'.repeat(64) },
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.balances[0].available, '123456789012345678901');
      assert.equal(
        (
          await fetch(url + path.replace(f.domainId, 'other-domain'), {
            headers: { authorization: 'Bearer ' + 'c'.repeat(64) },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(url + '/internal/exchange/customers/not-uuid/balances?domainId=domain', {
            headers: { authorization: 'Bearer ' + 'c'.repeat(64) },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(url + '/internal/exchange/events', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + 'c'.repeat(64),
              'content-type': 'application/json',
            },
            body: JSON.stringify({ schemaVersion: 2 }),
          })
        ).status,
        400,
      );
    } finally {
      await app.close();
    }
  },
);
