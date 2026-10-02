import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { migrate } from '../scripts/migrate.js';
import { LedgerActivity } from '../packages/shared/src/activity-contracts.js';

const enabled = !!process.env.TEST_LEDGER_DATABASE_URL;
const db = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const walletIds = [randomUUID(), randomUUID()];
const tenantId = `ledger-test-${randomUUID()}`;
const walletAddresses = [randomBytes(20).toString('hex'), randomBytes(20).toString('hex')].map(
  (address) => `0x${address}`,
);
const identifiers = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()].map(
  (id) => `transaction:ethereum:${id}`,
);
let service: LedgerService;

before(async () => {
  if (!db) return;
  await migrate(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
  await db.ledgerAccount.updateMany({
    where: { chain: 'ethereum', network: '11155111' },
    data: { last_entry_id: null },
  });
  await db.ledgerEntry.deleteMany({
    where: { account: { chain: 'ethereum', network: '11155111' } },
  });
  await db.ledgerActivity.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerAccount.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerWallet.deleteMany({ where: { tenant_id: { startsWith: 'ledger-test-' } } });
  service = new LedgerService(db);
  await Promise.all(
    walletIds.map((walletId, index) =>
      service.registerWallet({
        walletId,
        tenantId,
        chain: 'ethereum',
        network: '11155111',
        address: walletAddresses[index],
      }),
    ),
  );
});

after(async () => {
  if (!db) return;
  await db.ledgerAccount.updateMany({
    where: { chain: 'ethereum', network: '11155111' },
    data: { last_entry_id: null },
  });
  await db.ledgerEntry.deleteMany({
    where: { account: { chain: 'ethereum', network: '11155111' } },
  });
  await db.ledgerActivity.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerAccount.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerWallet.deleteMany({ where: { tenant_id: tenantId } });
  await db.$disconnect();
});

function activity(
  index: number,
  state: LedgerActivity['state'],
  blockHash: string,
): LedgerActivity {
  return {
    identifier: identifiers[index],
    chain: 'ethereum',
    network: '11155111',
    transactionHash: identifiers[index].split(':').at(-1)!,
    sourceStatus: 'success',
    state,
    completedAtTimestamp: 1000,
    blockHash,
    blockHeight: '10',
    changes: [
      {
        wallet: `wallet:ethereum:${walletAddresses[0]}`,
        asset: 'token:ethereum:native',
        amount: '-100',
      },
      {
        wallet: `wallet:ethereum:${walletAddresses[1]}`,
        asset: 'token:ethereum:native',
        amount: '100',
      },
    ],
  };
}

test(
  'ledger applies events idempotently, promotes provisional balances, and reverses reorged postings',
  { skip: !enabled },
  async () => {
    const first = activity(0, 'observed', '0xblock-a');
    await service.applyActivity(first);
    await service.applyActivity(first);
    let entries = await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } });
    assert.equal(entries, 2);
    const openingJournal = await db!.ledgerEntry.findMany({
      where: { activity_identifier: identifiers[0], revision: 0 },
    });
    const debits = openingJournal
      .filter((entry) => entry.side === 'debit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    const credits = openingJournal
      .filter((entry) => entry.side === 'credit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    assert.equal(debits.toString(), credits.toString());
    assert.equal(debits.toString(), '100');
    assert(openingJournal.every((entry) => entry.balance_after !== null));
    let balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '0');
    assert.equal(balances.balances[0].provisional, '-100');

    await service.applyActivity({ ...first, state: 'finalized' });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-100');
    assert.equal(balances.balances[0].provisional, '0');
    entries = await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } });
    assert.equal(entries, 6);
    await service.applyActivity({ ...first, state: 'finalized' });
    assert.equal(
      await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } }),
      entries,
    );
    const accounts = await db!.ledgerAccount.findMany({
      where: { wallet_id: { in: walletIds }, asset: 'token:ethereum:native' },
    });
    for (const account of accounts) {
      const chain = await db!.ledgerEntry.findMany({
        where: { account_key: account.account_key },
        orderBy: { sequence: 'asc' },
      });
      let previousBalance = new Prisma.Decimal(0);
      for (let index = 0; index < chain.length; index++) {
        assert.equal(chain[index].previous_entry_id, chain[index - 1]?.id ?? null);
        assert.equal(chain[index].next_entry_id, chain[index + 1]?.id ?? null);
        const normalDelta =
          chain[index].side === account.normal_side
            ? chain[index].amount
            : chain[index].amount.negated();
        previousBalance = previousBalance.plus(normalDelta);
        assert.equal(chain[index].balance_after.toString(), previousBalance.toString());
      }
      assert.equal(account.last_entry_id, chain.at(-1)?.id);
    }
    await service.applyActivity({ ...first, state: 'attention' });
    assert.equal(
      (await db!.ledgerActivity.findUniqueOrThrow({ where: { identifier: identifiers[0] } })).state,
      'finalized',
    );
    await service.applyActivity({
      ...first,
      state: 'observed',
      blockHash: undefined,
      blockHeight: undefined,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-100');
    assert.equal(balances.balances[0].provisional, '0');

    const second = activity(1, 'observed', '0xblock-b');
    await service.applyActivity(second);
    await service.applyActivity({ ...second, state: 'attention' });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-100');
    await service.applyActivity(second);
    await service.applyActivity({ ...second, state: 'finalized' });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-200');
    assert.equal(balances.balances[0].provisional, '0');

    await service.applyActivity(activity(3, 'attention', '0xblock-e'));
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-200');
    assert.equal(balances.balances[0].provisional, '-100');

    const third = activity(2, 'observed', '0xblock-c');
    await service.applyActivity(third);
    await service.applyActivity({ ...third, blockHash: '0xblock-d' });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-200');
    await service.applyActivity({
      ...third,
      state: 'reverted',
      blockHash: '0xblock-d',
      changes: [],
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-100');

    const feeActivity = activity(4, 'observed', '0xblock-fee');
    feeActivity.changes[0].amount = '-105';
    await service.applyActivity(feeActivity);
    const feeJournal = await db!.ledgerEntry.findMany({
      where: { activity_identifier: identifiers[4], revision: 0 },
    });
    const feeDebits = feeJournal
      .filter((entry) => entry.side === 'debit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    const feeCredits = feeJournal
      .filter((entry) => entry.side === 'credit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    assert.equal(feeDebits.toString(), feeCredits.toString());
    assert.equal(feeDebits.toString(), '105');
    const clearingEntry = feeJournal.find((entry) => entry.account_kind === 'clearing');
    assert.equal(clearingEntry?.side, 'debit');
    assert.equal(clearingEntry?.amount.toString(), '5');
  },
);
