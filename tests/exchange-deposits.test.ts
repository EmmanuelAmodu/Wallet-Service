import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';

const enabled = Boolean(process.env.TEST_LEDGER_DATABASE_URL);
const db = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const journal = new JournalService(new AccountsService());
const epoch = 'exchange-deposit-tests';
const service = enabled ? new DepositsService(db!, journal, { resetEpoch: epoch }) : undefined;
const asset = { chain: 'ethereum' as const, network: '11155111', assetId: 'token:ethereum:native' };
before(async () => {
  if (db) await db.$connect();
});
after(async () => {
  if (db) await db.$disconnect();
});

async function fixture() {
  const customerId = randomUUID(),
    domainId = `deposit-test-${randomUUID()}`,
    walletId = randomUUID(),
    hotWalletId = randomUUID();
  await db!.exchangeCustomer.create({ data: { customer_id: customerId, domain_id: domainId } });
  await db!.exchangeWallet.create({
    data: {
      wallet_id: hotWalletId,
      domain_id: domainId,
      chain: asset.chain,
      network: asset.network,
      address: hotWalletId,
      address_key: hotWalletId,
      role: 'hot',
      account: 0,
      registry_revision: 1,
      reset_epoch: epoch,
    },
  });
  await db!.exchangeWallet.create({
    data: {
      wallet_id: walletId,
      domain_id: domainId,
      customer_id: customerId,
      hot_wallet_id: hotWalletId,
      ...{ chain: asset.chain, network: asset.network },
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
      address_key: walletId,
      role: 'customer',
      account: 10,
      registry_revision: 1,
      reset_epoch: epoch,
    },
  });
  const depositId = randomUUID(),
    transactionHash = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const event = (
    type: 'deposit.observed.v1' | 'deposit.finalized.v1' | 'deposit.reverted.v1',
    revision: number,
    amount = '100',
  ): ExchangeEvent =>
    exchangeEventSchema.parse({
      type,
      schemaVersion: 1,
      eventId: randomUUID(),
      resetEpoch: epoch,
      occurredAt: new Date().toISOString(),
      domainId,
      customerId,
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: depositId,
      revision,
      data: {
        depositId,
        asset,
        transactionHash,
        transferIdentity: { kind: 'evm.native', id: 'top-level' },
        ...(type === 'deposit.reverted.v1'
          ? { reason: 'Canonical block reverted' }
          : { walletId, amount }),
        ...(type === 'deposit.finalized.v1' ? { blockHash: `block-${revision}` } : {}),
      },
    });
  const account = (type: AccountSpec['type'], assetId = asset.assetId): AccountSpec => ({
    domainId,
    ...asset,
    assetId,
    type,
    ownerKind: type === 'custody_deposit' ? 'wallet' : 'customer',
    ownerId: type === 'custody_deposit' ? walletId : customerId,
    normalSide: type === 'custody_deposit' || type === 'deficit' ? 'debit' : 'credit',
  });
  const balance = (type: AccountSpec['type'], assetId?: string) =>
    db!.$transaction((tx) => journal.balance(tx, account(type, assetId)));
  return { customerId, domainId, walletId, depositId, event, account, balance };
}

test(
  'final deposits credit exactly once under concurrent duplicate/reordered delivery',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const observed = f.event('deposit.observed.v1', 1, '1000000000000000000001');
    await service!.handle(observed);
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(
      (await db!.deposit.findUniqueOrThrow({ where: { id: f.depositId } })).state,
      'pending',
    );
    const finalized = f.event('deposit.finalized.v1', 2, '1000000000000000000001');
    await Promise.all([
      service!.handle(finalized),
      service!.handle(finalized),
      service!.handle({ ...finalized, eventId: randomUUID() }),
    ]);
    await service!.handle(observed);
    assert.equal(await f.balance('customer_available'), 1000000000000000000001n);
    assert.equal(await db!.journalBatch.count({ where: { domain_id: f.domainId } }), 1);
    assert.equal(
      await db!.outbox.count({
        where: {
          queue: 'wallet-actions',
          dedupe_key: { startsWith: `deposit:${f.depositId}:credited:` },
        },
      }),
      1,
    );
    await assert.rejects(
      service!.handle({
        ...finalized,
        eventId: randomUUID(),
        data: {
          ...finalized.data,
          depositId: randomUUID(),
        },
      } as ExchangeEvent),
      /different deposit ID/,
    );
    await assert.rejects(
      service!.handle({ ...finalized, data: { ...finalized.data, amount: '9' } } as ExchangeEvent),
      /different content/,
    );
  },
);

test(
  'unknown reverts fence late finality and restored finality has one compensating lifecycle',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await service!.handle(f.event('deposit.reverted.v1', 2));
    await service!.handle(f.event('deposit.finalized.v1', 1));
    assert.equal(await f.balance('customer_available'), 0n);
    await service!.handle(f.event('deposit.finalized.v1', 3));
    assert.equal(await f.balance('customer_available'), 100n);
    const reverted = f.event('deposit.reverted.v1', 4);
    await Promise.all([
      service!.handle(reverted),
      service!.handle({ ...reverted, eventId: randomUUID() }),
    ]);
    assert.equal(await f.balance('customer_available'), 0n);
    await service!.handle(f.event('deposit.finalized.v1', 5));
    assert.equal(await f.balance('customer_available'), 100n);
    assert.equal(await db!.journalBatch.count({ where: { domain_id: f.domainId } }), 3);
  },
);

test(
  'reorg after spending records exact deficit and freezes other available assets',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await service!.handle(f.event('deposit.finalized.v1', 1));
    const token = 'token:ethereum:erc20:0x1111111111111111111111111111111111111111';
    await db!.$transaction(async (tx) => {
      await journal.post(tx, {
        key: randomUUID(),
        domainId: f.domainId,
        revision: 1,
        kind: 'test.withdrawal',
        postings: [
          { account: f.account('customer_available'), side: 'debit', amount: 80n },
          { account: f.account('custody_deposit'), side: 'credit', amount: 80n },
        ],
      });
      await journal.post(tx, {
        key: randomUUID(),
        domainId: f.domainId,
        revision: 1,
        kind: 'test.token-deposit',
        postings: [
          { account: f.account('custody_deposit', token), side: 'debit', amount: 50n },
          { account: f.account('customer_available', token), side: 'credit', amount: 50n },
        ],
      });
    });
    await service!.handle(f.event('deposit.reverted.v1', 2));
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('deficit'), 80n);
    assert.equal(await f.balance('customer_available', token), 0n);
    assert.equal(await f.balance('customer_frozen', token), 50n);
    assert.equal(
      (await db!.exchangeCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } }))
        .state,
      'frozen',
    );
    assert.equal(await db!.ledgerIncident.count({ where: { domain_id: f.domainId } }), 1);
    assert.equal(
      await db!.outbox.count({
        where: { queue: 'wallet-actions', dedupe_key: { startsWith: `deposit:${f.depositId}:` } },
      }),
      4,
    );
    await service!.handle(f.event('deposit.finalized.v1', 3));
    assert.equal(await f.balance('deficit'), 0n);
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('customer_frozen'), 20n);
  },
);

test(
  'failed financial transaction rolls back credit, inbox, deposit and outbox for safe retry',
  { skip: !enabled },
  async () => {
    class InterruptedJournal extends JournalService {
      override async post(...args: Parameters<JournalService['post']>): Promise<never> {
        await super.post(...args);
        throw new Error('Injected crash after journal posting');
      }
    }
    const f = await fixture();
    const event = f.event('deposit.finalized.v1', 1);
    const interrupted = new DepositsService(db!, new InterruptedJournal(new AccountsService()), {
      resetEpoch: epoch,
    });
    await assert.rejects(interrupted.handle(event), /Injected crash/);
    assert.equal(await db!.deposit.count({ where: { id: f.depositId } }), 0);
    assert.equal(await db!.journalBatch.count({ where: { domain_id: f.domainId } }), 0);
    assert.equal(await db!.exchangeInbox.count({ where: { event_id: event.eventId } }), 0);
    await service!.handle(event);
    assert.equal(await f.balance('customer_available'), 100n);
  },
);

test(
  'stale epochs, wrong customers and changed canonical deposits never create credit',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const event = f.event('deposit.finalized.v1', 1);
    await assert.rejects(service!.handle({ ...event, resetEpoch: 'retired' }), /Stale reset epoch/);
    await assert.rejects(
      service!.handle({ ...event, customerId: randomUUID() } as ExchangeEvent),
      /not registered/,
    );
    await service!.handle(event);
    await assert.rejects(
      service!.handle(f.event('deposit.finalized.v1', 2, '101')),
      /amount or wallet identity changed/,
    );
    assert.equal(await f.balance('customer_available'), 100n);
  },
);
