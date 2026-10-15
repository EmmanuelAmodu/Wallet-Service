import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { OperationsService } from '../apps/wallet/src/operations/operations.service.js';
import { CustodyExecutionService } from '../apps/wallet/src/execution/execution.service.js';
import { WithdrawalsService } from '../apps/wallet/src/withdrawals/withdrawals.service.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { MessageAuth } from '../packages/queue/src/messages.js';
import { isolatedDatabase, custodySettings } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';

test(
  'Phase 9 attempt history backfills an existing execution and atomically preserves immutable deduplicated transitions',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const fixture = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    const db = new WalletPrismaService({ databaseUrl: fixture.url }),
      sql = new Client({ connectionString: fixture.url });
    const domainId = `attempts-${randomUUID()}`,
      epoch = randomUUID(),
      config = custodySettings(domainId),
      auth = new MessageAuth('a'.repeat(64), epoch);
    const custody = new CustodyService(
      db,
      config,
      { domainId, apiKey: undefined },
      auth,
      acceptanceRollout,
    );
    const operations = (scope = domainId, resetEpoch: string = epoch) =>
      new OperationsService(
        db,
        {} as ChainRpcService,
        new MessageAuth('a'.repeat(64), resetEpoch),
        { ...config, domainId: scope },
        {
          enabled: false,
          apiKey: undefined,
          actor: 'acceptance',
          intervalMs: 1000,
          freshnessMs: 300000,
          batchSize: 25,
        },
        {} as CustodyExecutionService,
        {} as WithdrawalsService,
      );
    try {
      await sql.connect();
      assert.equal(await db.custodyAttempt.count(), 0);
      // Establish a pre-Phase-9 fixture before any attempt history exists.
      await sql.query(`DROP TRIGGER custody_execution_attempt_journal ON custody_executions;
      DROP TRIGGER custody_transaction_attempt_journal ON transactions;
      DROP FUNCTION journal_custody_execution(); DROP FUNCTION journal_custody_transaction();
      DROP FUNCTION capture_custody_attempt(uuid,text);
      DROP TABLE custody_attempt_observations; DROP TABLE custody_attempts;
      DROP FUNCTION reject_custody_attempt_mutation();`);
      const bootstrap = await custody.bootstrap();
      const hot = bootstrap.hotWallets.find((w) => w.chain === 'ethereum')!;
      const root = async () => {
        const customerId = randomUUID();
        await db.exchangeCustomer.create({
          data: {
            customer_id: customerId,
            external_id: customerId,
            domain_id: domainId,
            reset_epoch: epoch,
          },
        });
        const source = await db.$transaction((tx) =>
          custody.allocateCustomer(tx, customerId, 'ethereum', '11155111'),
        );
        const transaction = await db.transaction.create({
          data: {
            id: randomUUID(),
            wallet_id: source.id,
            idempotency_key: randomUUID(),
            request_hash: 'a'.repeat(64),
            intent: {},
            status: 'preparing',
          },
        });
        return db.custodyExecution.create({
          data: {
            id: randomUUID(),
            operation_id: randomUUID(),
            attempt_id: randomUUID(),
            transaction_id: transaction.id,
            domain_id: domainId,
            reset_epoch: epoch,
            customer_id: customerId,
            source_wallet_id: source.id,
            hot_wallet_id: hot.id,
            request_digest: 'b'.repeat(64),
            plan: { type: 'sweep.plan.requested.v1' },
            state: 'planning',
          },
        });
      };
      const original = await root();
      const migration = await readFile(
        'apps/wallet/prisma/migrations/20261014010000_custody_attempt_history/migration.sql',
        'utf8',
      );
      await sql.query('BEGIN');
      await sql.query(migration);
      await sql.query('COMMIT');
      const baseline = await db.custodyAttemptObservation.findFirstOrThrow({
        where: { attempt_id: original.attempt_id },
      });
      assert.equal(baseline.provenance, 'migration_baseline');
      assert.equal((baseline.evidence as { state: string }).state, 'planning');
      assert.equal(
        (await db.custodyAttempt.findUniqueOrThrow({ where: { id: original.attempt_id } }))
          .operation_id,
        original.operation_id,
      );
      await db.transaction.update({
        where: { id: original.transaction_id },
        data: { status: 'attention' },
      });
      await db.custodyExecution.update({
        where: { id: original.id },
        data: { state: 'attention', revision: { increment: 1 } },
      });
      const count = await db.custodyAttemptObservation.count({
        where: { attempt_id: original.attempt_id },
      });
      assert.equal(count, 3);
      await db.custodyExecution.update({
        where: { id: original.id },
        data: { next_check_at: new Date() },
      });
      assert.equal(
        await db.custodyAttemptObservation.count({ where: { attempt_id: original.attempt_id } }),
        count,
      );
      await assert.rejects(
        () =>
          db.$transaction(async (tx) => {
            await tx.custodyExecution.update({
              where: { id: original.id },
              data: { state: 'planning', revision: { increment: 1 } },
            });
            throw new Error('Crash boundary before commit');
          }),
        /Crash boundary/,
      );
      assert.equal(
        await db.custodyAttemptObservation.count({ where: { attempt_id: original.attempt_id } }),
        count,
      );
      assert.equal(
        (await db.custodyExecution.findUniqueOrThrow({ where: { id: original.id } })).state,
        'attention',
      );
      for (const statement of [
        "UPDATE custody_attempts SET domain_id='other' WHERE id=$1",
        'DELETE FROM custody_attempts WHERE id=$1',
        "UPDATE custody_attempt_observations SET evidence='{}' WHERE attempt_id=$1",
        'DELETE FROM custody_attempt_observations WHERE attempt_id=$1',
      ])
        await assert.rejects(
          () => sql.query(statement, [original.attempt_id]),
          /history is immutable/,
        );
      await assert.rejects(
        () =>
          sql.query(
            `INSERT INTO custody_attempts(id,execution_id,operation_id,transaction_id,domain_id,reset_epoch,source_wallet_id,ordinal,predecessor_id,request_digest)
      SELECT $1,execution_id,operation_id,$2,domain_id,reset_epoch,source_wallet_id,1,id,request_digest FROM custody_attempts WHERE id=$3`,
            [randomUUID(), randomUUID(), original.attempt_id],
          ),
        (error: unknown) => (error as { code: string }).code === '23514',
      );
      assert.equal(
        (
          await sql.query(
            `SELECT count(*)::int AS invalid FROM custody_attempt_observations WHERE digest<>encode(sha256(convert_to(evidence::text,'UTF8')),'hex')`,
          )
        ).rows[0].invalid,
        0,
      );
      const second = await root();
      assert.equal(
        (
          await db.custodyAttemptObservation.findFirstOrThrow({
            where: { attempt_id: second.attempt_id },
          })
        ).provenance,
        'live_transition',
      );
      const history = await operations().attempts(original.transaction_id, undefined, 1);
      assert.equal(history.replacementEnabled, false);
      assert.equal(history.observations.length, 1);
      assert.ok(history.nextCursor);
      const next = await operations().attempts(original.transaction_id, history.nextCursor!, 1);
      assert.ok(BigInt(next.observations[0].sequence) > BigInt(history.observations[0].sequence));
      await assert.rejects(
        () => operations().attempts(second.transaction_id, history.nextCursor!),
        /another execution/,
      );
      await assert.rejects(
        () => operations('other-domain').attempts(original.transaction_id),
        /not found/,
      );
      await assert.rejects(
        () => operations(domainId, 'stale-epoch').attempts(original.transaction_id),
        /not found/,
      );
      await assert.rejects(
        () => operations().attempts(original.transaction_id, '9223372036854775808'),
        /pagination/,
      );
    } finally {
      await sql.end();
      await db.$disconnect();
      await fixture.drop();
    }
  },
);
