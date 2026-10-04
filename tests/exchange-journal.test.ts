import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  AccountsService,
  AccountSpec,
  canonicalAccount,
  journalAccountKey,
} from '../apps/ledger/src/accounts/accounts.service.js';
import {
  JournalService,
  JournalPosting,
  MAX_JOURNAL_AMOUNT,
} from '../apps/ledger/src/journal/journal.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { migrate } from '../scripts/migrate.js';

const enabled = !!process.env.TEST_LEDGER_DATABASE_URL;
const db = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const accounts = new AccountsService();
const journal = new JournalService(accounts);

function fixture() {
  const domainId = `exchange-journal-${randomUUID()}`;
  const ownerId = randomUUID();
  const available: AccountSpec = {
    domainId,
    chain: 'ethereum',
    network: '11155111',
    assetId: 'token:ethereum:native',
    type: 'customer_available',
    ownerKind: 'customer',
    ownerId,
    normalSide: 'credit',
  };
  const custody: AccountSpec = {
    ...available,
    type: 'custody_deposit',
    ownerKind: 'wallet',
    ownerId: randomUUID(),
    normalSide: 'debit',
  };
  return { domainId, available, custody };
}

function deposit(custody: AccountSpec, available: AccountSpec, amount: bigint): JournalPosting[] {
  return [
    { account: custody, side: 'debit', amount },
    { account: available, side: 'credit', amount },
  ];
}

before(async () => {
  if (!db) return;
  await migrate(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
  await db.$connect();
});

after(async () => {
  // Immutable journal fixtures deliberately use random domains instead of deleting history.
  await db?.$disconnect();
});

test('account identities normalize ERC-20 addresses and reject invalid ownership or sides', () => {
  const { available } = fixture();
  const token = `token:ethereum:erc20:0x${'AB'.repeat(20)}`;
  assert.equal(
    journalAccountKey({ ...available, assetId: token }),
    journalAccountKey({ ...available, assetId: token.toLowerCase() }),
  );
  assert.equal(
    canonicalAccount({
      ...available,
      chain: 'smartChain',
      assetId: `token:smartChain:erc20:0x${'AB'.repeat(20)}`,
    }).assetId,
    `token:smartChain:erc20:0x${'ab'.repeat(20)}`,
  );
  assert.throws(() => canonicalAccount({ ...available, normalSide: 'debit' }), /normal side/);
  assert.throws(() => canonicalAccount({ ...available, ownerKind: 'wallet' }), /owner/);
  assert.throws(
    () => canonicalAccount({ ...available, assetId: 'token:bitcoin:native' }),
    /canonical chain/,
  );
  assert.throws(
    () =>
      canonicalAccount({
        ...available,
        chain: 'bitcoin',
        assetId: `token:bitcoin:erc20:0x${'ab'.repeat(20)}`,
      }),
    /token standard/,
  );
});

test(
  'journal posts exact large base units without an activity and replays the batch once',
  { skip: !enabled },
  async () => {
    const { domainId, available, custody } = fixture();
    const amount = 10n ** 65n;
    const request = {
      key: randomUUID(),
      domainId,
      revision: 1,
      kind: 'deposit',
      postings: deposit(custody, available, amount),
    };
    const first = await db!.$transaction((tx) => journal.post(tx, request));
    const replay = await db!.$transaction((tx) =>
      journal.post(tx, { ...request, postings: [...request.postings].reverse() }),
    );
    assert.equal(first.id, replay.id);
    assert.equal(await db!.ledgerEntry.count({ where: { batch_id: first.id } }), 2);
    const rows = await db!.ledgerEntry.findMany({ where: { batch_id: first.id } });
    assert.ok(rows.every((entry) => entry.activity_identifier === null));
    assert.ok(rows.every((entry) => entry.account_kind === null && entry.entry_kind === null));
    await db!.$transaction((tx) =>
      journal.post(tx, {
        ...request,
        key: randomUUID(),
        revision: 2,
        postings: deposit(custody, available, 1n),
      }),
    );
    assert.equal(await db!.$transaction((tx) => journal.balance(tx, available)), amount + 1n);
    await assert.rejects(
      db!.$transaction((tx) =>
        journal.post(tx, {
          ...request,
          postings: deposit(custody, available, amount + 1n),
        }),
      ),
      /reused/,
    );
  },
);

test(
  'journal rejects cross-asset balancing and accepts separate balanced asset legs',
  { skip: !enabled },
  async () => {
    const { domainId, available, custody } = fixture();
    const bitcoin: AccountSpec = {
      ...available,
      chain: 'bitcoin',
      network: 'mainnet',
      assetId: 'token:bitcoin:native',
    };
    const bitcoinCustody: AccountSpec = {
      ...custody,
      ...bitcoin,
      type: 'custody_hot',
      ownerKind: 'wallet',
      normalSide: 'debit',
    };
    await assert.rejects(
      db!.$transaction((tx) =>
        journal.post(tx, {
          key: randomUUID(),
          domainId,
          revision: 1,
          kind: 'invalid',
          postings: [
            { account: custody, side: 'debit', amount: 100n },
            { account: bitcoin, side: 'credit', amount: 100n },
          ],
        }),
      ),
      /separately for each asset/,
    );
    const batch = await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId,
        revision: 1,
        kind: 'multi_asset',
        postings: [...deposit(custody, available, 100n), ...deposit(bitcoinCustody, bitcoin, 7n)],
      }),
    );
    assert.equal(await db!.ledgerEntry.count({ where: { batch_id: batch.id } }), 4);
    assert.equal(await db!.$transaction((tx) => journal.balance(tx, bitcoin)), 7n);
  },
);

test(
  'journal enforces uint256 limits and keeps customer liabilities nonnegative',
  { skip: !enabled },
  async () => {
    const { domainId, available, custody } = fixture();
    const request = {
      key: randomUUID(),
      domainId,
      revision: 1,
      kind: 'maximum',
      postings: deposit(custody, available, MAX_JOURNAL_AMOUNT),
    };
    await db!.$transaction((tx) => journal.post(tx, request));
    assert.equal(
      await db!.$transaction((tx) => journal.balance(tx, available)),
      MAX_JOURNAL_AMOUNT,
    );
    await assert.rejects(
      db!.$transaction((tx) =>
        journal.post(tx, {
          ...request,
          key: randomUUID(),
          postings: deposit(custody, available, 1n),
        }),
      ),
      /bounded integer/,
    );
    await assert.rejects(
      db!.$transaction((tx) =>
        journal.post(tx, {
          ...request,
          key: randomUUID(),
          postings: deposit(custody, available, MAX_JOURNAL_AMOUNT + 1n),
        }),
      ),
      /bounded integer/,
    );
    const empty = fixture();
    await assert.rejects(
      db!.$transaction((tx) =>
        journal.post(tx, {
          key: randomUUID(),
          domainId: empty.domainId,
          revision: 1,
          kind: 'overspend',
          postings: [
            { account: empty.available, side: 'debit', amount: 1n },
            { account: empty.custody, side: 'credit', amount: 1n },
          ],
        }),
      ),
      /cannot become negative/,
    );
    assert.equal(await db!.journalBatch.count({ where: { domain_id: empty.domainId } }), 0);
  },
);

test(
  'concurrent journal holds serialize and cannot overdraw one customer balance',
  { skip: !enabled },
  async () => {
    const { domainId, available, custody } = fixture();
    const reserved: AccountSpec = { ...available, type: 'customer_reserved' };
    await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId,
        revision: 1,
        kind: 'deposit',
        postings: deposit(custody, available, 100n),
      }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        db!.$transaction((tx) =>
          journal.post(tx, {
            key: randomUUID(),
            domainId,
            revision: 1,
            kind: 'hold',
            postings: [
              { account: available, side: 'debit', amount: 80n },
              { account: reserved, side: 'credit', amount: 80n },
            ],
          }),
        ),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(await db!.$transaction((tx) => journal.balance(tx, available)), 20n);
    assert.equal(await db!.$transaction((tx) => journal.balance(tx, reserved)), 80n);
    const tail = await db!.ledgerEntry.findMany({
      where: { account_key: journalAccountKey(available) },
      orderBy: { sequence: 'asc' },
    });
    assert.deepEqual(
      tail.map((entry) => entry.sequence),
      [1n, 2n],
    );
    assert.equal(tail[1].previous_entry_id, tail[0].id);
  },
);

test(
  'database prevents journal/account mutation and later appends to a sealed batch',
  { skip: !enabled },
  async () => {
    const { domainId, available, custody } = fixture();
    const batch = await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId,
        revision: 1,
        kind: 'deposit',
        postings: deposit(custody, available, 100n),
      }),
    );
    const entry = await db!.ledgerEntry.findFirstOrThrow({ where: { batch_id: batch.id } });
    await assert.rejects(
      db!.ledgerEntry.update({
        where: { id: entry.id },
        data: { balance_after: new Prisma.Decimal('999') },
      }),
      /append-only/,
    );
    await assert.rejects(db!.ledgerEntry.delete({ where: { id: entry.id } }), /append-only/);
    await assert.rejects(
      db!.ledgerAccount.update({
        where: { id: entry.account_id! },
        data: { owner_id: randomUUID() },
      }),
      /append-only/,
    );
    await assert.rejects(
      db!.journalBatch.update({ where: { id: batch.id }, data: { kind: 'changed' } }),
      /append-only/,
    );
    await assert.rejects(db!.journalBatch.delete({ where: { id: batch.id } }), /append-only/);
    await assert.rejects(
      db!.$transaction(async (tx) => {
        const account = await accounts.ensure(tx, custody);
        const previous = await tx.ledgerEntry.findFirstOrThrow({
          where: { account_id: account.id },
          orderBy: { sequence: 'desc' },
        });
        await tx.ledgerEntry.create({
          data: {
            id: randomUUID(),
            batch_id: batch.id,
            account_id: account.id,
            revision: 1,
            account_key: account.account_key,
            asset: account.asset_id,
            sequence: previous.sequence + 1n,
            previous_entry_id: previous.id,
            side: 'debit',
            amount: new Prisma.Decimal('1'),
            balance_after: new Prisma.Decimal('101'),
          },
        });
      }),
      /cannot accept more entries/,
    );
  },
);

test(
  'database rejects empty or unbalanced batches even when the service is bypassed',
  { skip: !enabled },
  async () => {
    const { domainId, custody, available } = fixture();
    const request = {
      id: randomUUID(),
      key: randomUUID(),
      domain_id: domainId,
      revision: 1,
      kind: 'raw_invalid',
      request_digest: 'a'.repeat(64),
    };
    await assert.rejects(db!.journalBatch.create({ data: request }), /at least two entries/);
    await assert.rejects(
      db!.$transaction(async (tx) => {
        const account = await accounts.ensure(tx, custody);
        const batch = await tx.journalBatch.create({ data: request });
        await tx.ledgerEntry.create({
          data: {
            id: randomUUID(),
            batch_id: batch.id,
            account_id: account.id,
            revision: 1,
            account_key: account.account_key,
            asset: account.asset_id,
            sequence: 1n,
            side: 'debit',
            amount: new Prisma.Decimal('100'),
            balance_after: new Prisma.Decimal('100'),
          },
        });
      }),
      /at least two entries/,
    );
    assert.equal(await db!.journalBatch.findUnique({ where: { id: request.id } }), null);
    assert.equal(await db!.ledgerEntry.count({ where: { batch_id: request.id } }), 0);
    for (const crossAsset of [false, true]) {
      await assert.rejects(
        db!.$transaction(async (tx) => {
          const debit = await accounts.ensure(tx, custody);
          const credit = await accounts.ensure(
            tx,
            crossAsset
              ? {
                  ...available,
                  chain: 'bitcoin',
                  network: 'mainnet',
                  assetId: 'token:bitcoin:native',
                }
              : available,
          );
          const batch = await tx.journalBatch.create({ data: request });
          for (const [account, side, amount] of [
            [debit, 'debit', '100'],
            [credit, 'credit', crossAsset ? '100' : '99'],
          ] as const) {
            await tx.ledgerEntry.create({
              data: {
                id: randomUUID(),
                batch_id: batch.id,
                account_id: account.id,
                revision: 1,
                account_key: account.account_key,
                asset: account.asset_id,
                sequence: 1n,
                side,
                amount: new Prisma.Decimal(amount),
                balance_after: new Prisma.Decimal(amount),
              },
            });
          }
        }),
        /balance separately for each asset/,
      );
    }
  },
);

test(
  'database rejects fractional exchange units and inconsistent running balances',
  { skip: !enabled },
  async () => {
    for (const fractional of [true, false]) {
      const { domainId, custody } = fixture();
      await assert.rejects(
        db!.$transaction(async (tx) => {
          const account = await accounts.ensure(tx, custody);
          const batch = await tx.journalBatch.create({
            data: {
              id: randomUUID(),
              key: randomUUID(),
              domain_id: domainId,
              revision: 1,
              kind: 'raw_invalid',
              request_digest: 'b'.repeat(64),
            },
          });
          await tx.ledgerEntry.create({
            data: {
              id: randomUUID(),
              batch_id: batch.id,
              account_id: account.id,
              revision: 1,
              account_key: account.account_key,
              asset: account.asset_id,
              sequence: 1n,
              side: 'debit',
              amount: new Prisma.Decimal(fractional ? '0.1' : '1'),
              balance_after: new Prisma.Decimal(fractional ? '0.1' : '999'),
            },
          });
        }),
        fractional ? /exchange_units_check/ : /does not extend its account tail/,
      );
    }
  },
);
