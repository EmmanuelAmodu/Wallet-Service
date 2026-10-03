import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Prisma } from '@prisma/client';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { migrate } from '../scripts/migrate.js';

const testUrl = process.env.TEST_LEDGER_DATABASE_URL;

test(
  'populated legacy Ledger migrates to balanced opening postings without losing source data',
  { skip: !testUrl, timeout: 30000 },
  async () => {
    const databaseName = `ledger_upgrade_${randomUUID().replaceAll('-', '')}`;
    const adminUrl = new URL(testUrl!);
    adminUrl.pathname = '/postgres';
    const upgradeUrl = new URL(testUrl!);
    upgradeUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminUrl.toString() });
    let legacy: Pool | undefined;
    let db: LedgerPrismaService | undefined;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      legacy = new Pool({ connectionString: upgradeUrl.toString() });
      const initialMigration = await readFile(
        resolve('apps/ledger/prisma/migrations/20261002210703_initial_ledger/migration.sql'),
        'utf8',
      );
      await legacy.query(initialMigration);

      const walletId = randomUUID();
      const secondWalletId = randomUUID();
      const secondAddress = `0x${'22'.repeat(20)}`;
      const activityId = `transaction:ethereum:${randomUUID()}`;
      const legacyEntryId = randomUUID();
      const address = `0x${'11'.repeat(20)}`;
      const asset = 'token:ethereum:native';
      await legacy.query(
        `INSERT INTO ledger_wallets (wallet_id, tenant_id, chain, network, address, address_key)
         VALUES ($1, 'migration-test', 'ethereum', '11155111', $2, $2)`,
        [walletId, address],
      );
      await legacy.query(
        `INSERT INTO ledger_activities
          (identifier, chain, network, transaction_hash, state, revision, block_hash, block_height,
           completed_at_ms, source_status, payload, updated_at)
         VALUES ($1, 'ethereum', '11155111', 'legacy', 'observed', 4, '0xlegacy-block', 10,
                 1, 'success', '{}'::jsonb, now())`,
        [activityId],
      );
      await legacy.query(
        `INSERT INTO ledger_entries
          (id, activity_identifier, revision, wallet_id, asset, amount, kind)
         VALUES
          ($1, $3, 4, $2, $4, 100, 'provisional')`,
        [legacyEntryId, walletId, activityId, asset],
      );
      await legacy.query(
        `INSERT INTO ledger_balances
          (wallet_id, asset, confirmed_amount, provisional_amount, updated_at)
         VALUES ($1, $2, 0, 100, now())`,
        [walletId, asset],
      );
      await legacy.query(
        `INSERT INTO ledger_wallets (wallet_id, tenant_id, chain, network, address, address_key)
         VALUES ($1, 'migration-test', 'ethereum', '11155111', $2, $2)`,
        [secondWalletId, secondAddress],
      );
      await legacy.query(
        `INSERT INTO ledger_entries (id, activity_identifier, revision, wallet_id, asset, amount, kind)
         VALUES ($1, $2, 4, $3, $4, -100, 'provisional')`,
        [randomUUID(), activityId, secondWalletId, asset],
      );
      await legacy.query(
        `INSERT INTO ledger_balances (wallet_id, asset, confirmed_amount, provisional_amount, updated_at)
         VALUES ($1, $2, 0, -100, now())`,
        [secondWalletId, asset],
      );
      await legacy.end();
      legacy = undefined;

      const baseline = spawnSync(
        process.execPath,
        [
          resolve('node_modules/prisma/build/index.js'),
          'migrate',
          'resolve',
          '--applied',
          '20261002210703_initial_ledger',
          '--config',
          'prisma.ledger.config.ts',
        ],
        {
          env: { ...process.env, LEDGER_DATABASE_URL: upgradeUrl.toString() },
          encoding: 'utf8',
        },
      );
      assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
      await migrate(upgradeUrl.toString(), 'ledger');

      db = new LedgerPrismaService({ databaseUrl: upgradeUrl.toString() });
      const archived = await db.$queryRaw<{ entries: bigint; balances: bigint }[]>`
        SELECT
          (SELECT count(*) FROM ledger_legacy_entries) AS entries,
          (SELECT count(*) FROM ledger_legacy_balances) AS balances
      `;
      assert.equal(archived[0].entries, 2n);
      assert.equal(archived[0].balances, 2n);

      const accountTable = await db.$queryRaw<{ table_name: string | null }[]>`
        SELECT to_regclass('public.ledger_accounts')::text AS table_name
      `;
      assert.equal(accountTable[0].table_name, null);
      const walletEntries = await db.ledgerEntry.findMany({
        where: { wallet_id: walletId },
        orderBy: [{ account_key: 'asc' }, { sequence: 'desc' }],
      });
      const openingBalances = new Map<string, string>();
      for (const entry of walletEntries) {
        if (!openingBalances.has(entry.account_key))
          openingBalances.set(
            entry.account_key,
            `${entry.balance_state}:${entry.balance_after.toFixed(0)}`,
          );
      }
      assert.deepEqual([...openingBalances.values()].sort(), ['provisional:100']);
      const migratedPosting = await db.ledgerEntry.findUniqueOrThrow({
        where: { id: legacyEntryId },
      });
      assert.equal(migratedPosting.activity_identifier, activityId);
      assert.equal(migratedPosting.revision, 4);

      const journal = await db.ledgerEntry.findMany();
      const debits = journal
        .filter((entry) => entry.side === 'debit')
        .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
      const credits = journal
        .filter((entry) => entry.side === 'credit')
        .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
      assert.equal(journal.length, 4);
      assert.equal(debits.toFixed(0), '200');
      assert.equal(credits.toFixed(0), '200');

      const service = new LedgerService(db);
      await service.applyActivity({
        identifier: activityId,
        chain: 'ethereum',
        network: '11155111',
        transactionHash: 'legacy',
        sourceStatus: 'success',
        state: 'finalized',
        completedAtTimestamp: 1,
        observationSequence: '1',
        canonicalReconciliation: true,
        blockHash: '0xlegacy-block',
        blockHeight: '10',
        changes: [
          { wallet: `wallet:ethereum:${address}`, asset, amount: '100' },
          { wallet: `wallet:ethereum:${secondAddress}`, asset, amount: '-100' },
        ],
      });
      const balances = await service.balances(walletId, 'migration-test');
      assert.equal(balances.balances[0].confirmed, '100');
      assert.equal(balances.balances[0].provisional, '0');
      const second = await service.balances(secondWalletId, 'migration-test');
      assert.equal(second.balances[0].confirmed, '-100');
      assert.equal(second.balances[0].provisional, '0');
      const migratedActivity = await db.ledgerActivity.findUniqueOrThrow({
        where: { identifier: activityId },
      });
      assert.equal(migratedActivity.revision, 5);
    } finally {
      await legacy?.end();
      await db?.$disconnect();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
