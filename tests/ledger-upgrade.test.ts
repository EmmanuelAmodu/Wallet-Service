import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { migrate } from '../scripts/migrate.js';

const testUrl = process.env.TEST_LEDGER_DATABASE_URL;
test(
  'forward migration repairs aggregate openings before and after legacy finalization',
  { skip: !testUrl, timeout: 60000 },
  async () => {
    const name = `ledger_forward_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(testUrl!);
    url.pathname = `/${name}`;
    const adminUrl = new URL(testUrl!);
    adminUrl.pathname = '/postgres';
    const admin = new Pool({ connectionString: adminUrl.toString() });
    let pool: Pool | undefined;
    let db: LedgerPrismaService | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      pool = new Pool({ connectionString: url.toString() });
      const directory = resolve('apps/ledger/prisma/migrations');
      const names = (await readdir(directory))
        .filter((name) => name !== 'migration_lock.toml')
        .sort();
      await pool.query(await readFile(`${directory}/${names[0]}/migration.sql`, 'utf8'));
      const walletId = randomUUID(),
        address = `0x${'33'.repeat(20)}`;
      const asset = 'token:ethereum:native';
      const pendingId = `transaction:ethereum:${randomUUID()}`;
      const settledId = `transaction:ethereum:${randomUUID()}`;
      await pool.query(
        `INSERT INTO ledger_wallets(wallet_id, tenant_id, chain, network, address, address_key)
        VALUES($1, 'forward-test', 'ethereum', '11155111', $2, $2)`,
        [walletId, address],
      );
      for (const [id, amount] of [
        [pendingId, 100],
        [settledId, 50],
      ] as const) {
        await pool.query(
          `INSERT INTO ledger_activities(identifier, chain, network, transaction_hash, state,
          revision, completed_at_ms, source_status, payload, updated_at, block_hash)
          VALUES($1, 'ethereum', '11155111', $1, 'observed', 0, 1, 'success', '{}', now(), 'block')`,
          [id],
        );
        await pool.query(
          `INSERT INTO ledger_entries(id, activity_identifier, revision, wallet_id, asset, amount, kind)
          VALUES($1, $2, 0, $3, $4, $5, 'provisional')`,
          [randomUUID(), id, walletId, asset, amount],
        );
      }
      await pool.query(
        `INSERT INTO ledger_balances(wallet_id, asset, confirmed_amount, provisional_amount, updated_at)
        VALUES($1, $2, 0, 150, now())`,
        [walletId, asset],
      );
      const repairName = '20261003230000_repair_legacy_activity_links';
      const previous = names.filter((name) => name !== repairName);
      for (const migration of previous.slice(1)) {
        const file =
          migration === '20261002221045_double_entry_journal'
            ? resolve('tests/fixtures/legacy-aggregate-cutover.sql')
            : `${directory}/${migration}/migration.sql`;
        await pool.query(await readFile(file, 'utf8'));
      }
      db = new LedgerPrismaService({ databaseUrl: url.toString() });
      const service = new LedgerService(db);
      const finalize = (identifier: string, amount: string) =>
        service.applyActivity({
          identifier,
          chain: 'ethereum',
          network: '11155111',
          transactionHash: identifier,
          state: 'finalized',
          sourceStatus: 'success',
          observationSequence: '1',
          canonicalReconciliation: true,
          completedAtTimestamp: 1,
          blockHash: 'block',
          changes: [{ wallet: `wallet:ethereum:${address}`, asset, amount }],
        });
      // Simulate a transaction finalized by the old code before deploying the repair.
      await finalize(settledId, '50');
      const originalEntries = await db.ledgerEntry.findMany();
      for (const migration of previous) {
        const result = spawnSync(
          process.execPath,
          [
            resolve('node_modules/prisma/build/index.js'),
            'migrate',
            'resolve',
            '--applied',
            migration,
            '--config',
            'prisma.ledger.config.ts',
          ],
          {
            env: { ...process.env, LEDGER_DATABASE_URL: url.toString() },
            encoding: 'utf8',
          },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      await migrate(url.toString(), 'ledger');
      let balances = (await service.balances(walletId, 'forward-test')).balances[0];
      assert.equal(balances.confirmed, '50');
      assert.equal(balances.provisional, '100');
      await finalize(pendingId, '100');
      balances = (await service.balances(walletId, 'forward-test')).balances[0];
      assert.equal(balances.confirmed, '150');
      assert.equal(balances.provisional, '0');
      for (const entry of originalEntries)
        assert.deepEqual(await db.ledgerEntry.findUnique({ where: { id: entry.id } }), entry);
      // The SQL is also safe to rerun during a migration recovery.
      const count = await db.ledgerEntry.count();
      await pool.query(await readFile(`${directory}/${repairName}/migration.sql`, 'utf8'));
      assert.equal(await db.ledgerEntry.count(), count);
      const unbalanced = await pool.query(`SELECT activity_identifier FROM ledger_entries
        GROUP BY activity_identifier, revision, asset, balance_state
        HAVING sum(CASE WHEN side = 'debit' THEN amount ELSE -amount END) <> 0`);
      assert.equal(unbalanced.rowCount, 0);
    } finally {
      await db?.$disconnect();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
