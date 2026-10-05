import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { migrate } from '../scripts/migrate.js';

const testUrl = process.env.TEST_LEDGER_DATABASE_URL;

test(
  'Ledger migrations preserve the baseline and add exchange account identities without mutable balances',
  { skip: !testUrl },
  async () => {
    await migrate(testUrl!, 'ledger');
    const db = new LedgerPrismaService({ databaseUrl: testUrl! });
    try {
      const migrations = await db.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      assert.equal(migrations.length, 5);
      assert(migrations.some((migration) => /fresh_baseline/.test(migration.migration_name)));
      assert(migrations.some((migration) => /exchange_accounting/.test(migration.migration_name)));
      assert(migrations.some((migration) => /single_owner/.test(migration.migration_name)));
      assert(
        migrations.some((migration) => /settlement_reversal_fence/.test(migration.migration_name)),
      );

      const tables = await db.$queryRaw<
        {
          wallets: string | null;
          activities: string | null;
          entries: string | null;
          accounts: string | null;
        }[]
      >`
        SELECT
          to_regclass('public.ledger_wallets')::text AS wallets,
          to_regclass('public.ledger_activities')::text AS activities,
          to_regclass('public.ledger_entries')::text AS entries,
          to_regclass('public.ledger_accounts')::text AS accounts
      `;
      assert.equal(tables[0].wallets, 'ledger_wallets');
      assert.equal(tables[0].activities, 'ledger_activities');
      assert.equal(tables[0].entries, 'ledger_entries');
      assert.equal(tables[0].accounts, 'ledger_accounts');
      const balanceColumns = await db.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ledger_accounts'
        AND column_name IN ('balance', 'next_sequence', 'balance_after')
      `;
      assert.equal(balanceColumns.length, 0);
      const tenantColumns = await db.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('tenant_id', 'tenantId')
      `;
      assert.equal(tenantColumns.length, 0);

      const hashIndex = await db.$queryRaw<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'ledger_activities_chain_network_transaction_hash_key_idx'
      `;
      assert.equal(hashIndex.length, 1);
    } finally {
      await db.$disconnect();
    }
  },
);
