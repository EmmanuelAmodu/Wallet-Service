import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { ActivityWorkflowService } from '../apps/activity-listener/src/activity-workflow.service.js';
import { ActivityProcessor } from '../apps/activity-listener/src/activity.processor.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { LedgerProcessor } from '../apps/ledger/src/ledger.processor.js';
import { connection } from '../packages/queue/src/messaging.module.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { ProcessorActivity } from '../packages/shared/src/activity-contracts.js';

const databaseUrl = process.env.TEST_LEDGER_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
test(
  'Solana queue recovery retains inclusion through RPC exhaustion and reverses missing activity',
  { skip: !databaseUrl || !redisUrl, timeout: 15000 },
  async () => {
    const db = new LedgerPrismaService({ databaseUrl: databaseUrl! });
    const ledger = new LedgerService(db);
    const auth = new MessageAuth('8'.repeat(64));
    const options = {
      connection: connection(redisUrl!),
      prefix: `solana-recovery-${randomUUID()}`,
    };
    const activityQueue = new Queue(QUEUES.activity, options);
    const ledgerQueue = new Queue(QUEUES.ledger, options);
    const walletId = randomUUID(),
      hash = randomUUID(),
      address = randomUUID();
    const identifier = `transaction:solana:devnet:${hash}`;
    const asset = `token:solana:${randomUUID()}`;
    let calls = 0;
    const workflow = new ActivityWorkflowService(
      {
        networkIdentity: () => 'devnet',
        observeTransaction: async () => {
          calls++;
          if (calls === 1) return { state: 'observed', transactionFound: true, blockHeight: '20' };
          if (calls === 2) throw new Error('Transient RPC outage');
          return { state: 'observed', transactionFound: false };
        },
      } as never,
      auth,
      activityQueue,
      ledgerQueue,
      {
        pubsubProjectId: 'test',
        pubsubSubscription: 'test',
        pubsubApiEndpoint: undefined,
        finalityPollMs: 60000,
        finalityMaxPolls: 120,
        reconciliationPollMs: 60000,
      },
    );
    const activityProcessor = new ActivityProcessor(workflow, auth);
    const ledgerProcessor = new LedgerProcessor(ledger, auth);
    const activityWorker = new Worker(
      QUEUES.activity,
      (job) => activityProcessor.process(job),
      options,
    );
    const ledgerWorker = new Worker(QUEUES.ledger, (job) => ledgerProcessor.process(job), options);
    const waitForState = async (state: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = await db.ledgerActivity.findUnique({ where: { identifier } });
        if (row?.state === state) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Did not reach ${state}`);
    };
    const promoteCheck = async (poll: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        for (const job of await activityQueue.getJobs(['delayed'])) {
          const message = auth.open(job.data, job.id!, job.name);
          if (message.type === 'activity.check-finality' && message.poll === poll) {
            assert.equal(message.previouslyIncluded, true);
            assert.equal(message.blockHash, undefined);
            await job.promote();
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Missing check ${poll}`);
    };
    try {
      await Promise.all([activityWorker.waitUntilReady(), ledgerWorker.waitUntilReady()]);
      await ledger.registerWallet({
        walletId,
        chain: 'solana',
        network: 'devnet',
        address,
      });
      const activity: ProcessorActivity = {
        identifier: `transaction:solana:${hash}`,
        completedAtTimestamp: 1,
        metadata: {},
        status: 'success',
        transfers: [],
        tokenIdentifiers: [asset],
        fee: { amount: 0, feePayer: [] },
        balanceChanges: [
          { wallet: `wallet:solana:${address}`, changes: [{ token: asset, amount: '100' }] },
        ],
      };
      const jobId = randomUUID();
      await activityQueue.add(
        'activity.received',
        auth.seal({ type: 'activity.received', pubsubMessageId: 'test', activity }, jobId),
        { jobId },
      );
      await waitForState('observed');
      assert.equal((await ledger.balances(walletId)).balances[0].provisional, '100');
      await promoteCheck(1);
      await waitForState('attention');
      await promoteCheck(2);
      await waitForState('reverted');
      const balance = (await ledger.balances(walletId)).balances[0];
      assert.equal(balance.provisional, '0');
      assert.equal(balance.confirmed, '0');
    } finally {
      await Promise.all([activityWorker.close(), ledgerWorker.close()]);
      await activityQueue.obliterate({ force: true });
      await ledgerQueue.obliterate({ force: true });
      await Promise.all([activityQueue.close(), ledgerQueue.close()]);
      await db.ledgerEntry.updateMany({
        where: { activity_identifier: identifier },
        data: { previous_entry_id: null },
      });
      await db.ledgerEntry.deleteMany({ where: { activity_identifier: identifier } });
      await db.ledgerActivity.deleteMany({ where: { identifier } });
      await db.ledgerWallet.deleteMany({ where: { wallet_id: walletId } });
      await db.$disconnect();
    }
  },
);
