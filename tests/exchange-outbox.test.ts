import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Queue } from 'bullmq';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { connection } from '../packages/queue/src/messaging.module.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { OutboxRelay } from '../packages/queue/src/outbox.service.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { migrate } from '../scripts/migrate.js';

test(
  'a committed hold survives a lost Redis acknowledgement and a restarted relay redelivers one immutable result',
  {
    skip: !process.env.TEST_LEDGER_DATABASE_URL || !process.env.TEST_REDIS_URL,
    timeout: 30000,
  },
  async () => {
    const name = `phase2_delivery_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_LEDGER_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.TEST_LEDGER_DATABASE_URL!);
    url.pathname = `/${name}`;
    const db = new LedgerPrismaService({ databaseUrl: url.toString() });
    const queue = new Queue(QUEUES.wallet, {
      connection: connection(process.env.TEST_REDIS_URL!),
      prefix: name,
    });
    try {
      await migrate(url.toString(), 'ledger');
      const domainId = name,
        customerId = randomUUID(),
        walletId = randomUUID(),
        epoch = name;
      const asset = {
        chain: 'ethereum' as const,
        network: '11155111',
        assetId: 'token:ethereum:native',
      };
      const journal = new JournalService(new AccountsService());
      const account = (type: 'customer_available' | 'customer_reserved'): AccountSpec => ({
        domainId,
        ...asset,
        type,
        ownerId: customerId,
        ownerKind: 'customer',
        normalSide: 'credit',
      });
      await db.$transaction(async (tx) => {
        await tx.exchangeCustomer.create({
          data: { customer_id: customerId, domain_id: domainId },
        });
        await tx.exchangeWallet.create({
          data: {
            wallet_id: walletId,
            domain_id: domainId,
            chain: asset.chain,
            network: asset.network,
            address: '0x' + '12'.repeat(20),
            address_key: '0x' + '12'.repeat(20),
            role: 'hot',
            account: 0,
            registry_revision: 1,
            reset_epoch: epoch,
          },
        });
        await journal.post(tx, {
          key: randomUUID(),
          domainId,
          revision: 1,
          kind: 'explicit-test-fixture',
          postings: [
            {
              account: {
                ...account('customer_available'),
                type: 'custody_hot',
                ownerId: walletId,
                ownerKind: 'wallet',
                normalSide: 'debit',
              },
              side: 'debit',
              amount: 100n,
            },
            { account: account('customer_available'), side: 'credit', amount: 100n },
          ],
        });
      });
      const reservations = new ReservationsService(db, journal, { resetEpoch: epoch });
      await reservations.handle(
        exchangeEventSchema.parse({
          eventId: randomUUID(),
          schemaVersion: 1,
          resetEpoch: epoch,
          occurredAt: new Date().toISOString(),
          domainId,
          correlationId: randomUUID(),
          causationId: null,
          aggregateId: customerId,
          revision: 1,
          customerId,
          operationId: randomUUID(),
          requestDigest: 'a'.repeat(64),
          policyVersion: 'exchange-financial-v1',
          type: 'withdrawal.reserve.requested.v1',
          data: {
            amounts: [{ asset, amount: '80' }],
            principal: { asset, amount: '80' },
            hotWalletId: walletId,
            destination: '0x' + '34'.repeat(20),
            quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        }),
      );
      const result = await db.outbox.findFirstOrThrow();
      const auth = new MessageAuth('a'.repeat(64), epoch);
      const lostAcknowledgement = {
        add: async (...args: Parameters<Queue['add']>) => {
          await queue.add(...args);
          throw new Error('Injected lost Redis acknowledgement');
        },
      } as unknown as Queue;
      const failedRelay = new OutboxRelay(
        db,
        auth,
        lostAcknowledgement,
        queue,
        queue,
        queue,
        queue,
        { outboxIntervalMs: 50 },
      );
      await assert.rejects(failedRelay.flush(), /lost Redis acknowledgement/);
      assert.equal(
        (await db.outbox.findUniqueOrThrow({ where: { id: result.id } })).published_at,
        null,
      );
      const recoveredRelay = new OutboxRelay(db, auth, queue, queue, queue, queue, queue, {
        outboxIntervalMs: 50,
      });
      await recoveredRelay.flush();
      await recoveredRelay.flush();
      assert.equal(await queue.getWaitingCount(), 1);
      const job = await queue.getJob(result.id);
      assert(job);
      assert.equal(auth.open(job.data, job.id!, job.name).type, 'withdrawal.reserved.v1');
      assert((await db.outbox.findUniqueOrThrow({ where: { id: result.id } })).published_at);
      assert.equal(
        await db.$transaction((tx) => journal.balance(tx, account('customer_available'))),
        20n,
      );
      assert.equal(
        await db.$transaction((tx) => journal.balance(tx, account('customer_reserved'))),
        80n,
      );
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await db.$disconnect();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
