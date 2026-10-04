import 'reflect-metadata';
import { after, test } from 'node:test';
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
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../packages/queue/src/exchange-contracts.js';
import { queueConfig } from '../packages/queue/src/queue.config.js';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';

const databaseUrl = process.env.TEST_LEDGER_DATABASE_URL;
const db = databaseUrl ? new LedgerPrismaService({ databaseUrl }) : undefined;
const config = { resetEpoch: 'exchange-settlements-test' };
const journal = new JournalService(new AccountsService());
const registry = db ? new ExchangeRegistryService(db) : undefined;
const deposits = db ? new DepositsService(db, journal, config) : undefined;
const reservations = db ? new ReservationsService(db, journal, config) : undefined;
const settlements = db ? new SettlementsService(db, journal, reservations!) : undefined;
const native: CanonicalAsset = {
  chain: 'ethereum',
  network: '11155111',
  assetId: 'token:ethereum:native',
};
const token: CanonicalAsset = { ...native, assetId: 'token:ethereum:erc20:0x' + 'ab'.repeat(20) };
after(async () => {
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
  const reserve = async (amount = '200', fee?: { asset: CanonicalAsset; amount: string }) => {
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
    await settlements!.handle(execution);
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
