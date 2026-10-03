import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { connection } from '../packages/queue/src/messaging.module.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { reconcileActivity } from '../scripts/queue.js';

test('queue envelopes reject tampering, wrong job IDs, action substitution and wrong keys', () => {
  const auth = new MessageAuth('a'.repeat(64));
  const message = { type: 'transaction.prepare' as const, transactionId: randomUUID() };
  const envelope = auth.seal(message);
  assert.deepEqual(auth.open(envelope, envelope.id, message.type), message);
  assert.throws(() =>
    auth.open(
      { ...envelope, payload: { ...message, transactionId: randomUUID() } },
      envelope.id,
      message.type,
    ),
  );
  assert.throws(() => auth.open(envelope, randomUUID(), message.type));
  assert.throws(() => auth.open(envelope, envelope.id, 'transaction.sign'));
  assert.throws(() => new MessageAuth('b'.repeat(64)).open(envelope, envelope.id, message.type));
});

test('activity reconciliation retries the latest retained check and releases delayed checks', async () => {
  const auth = new MessageAuth('e'.repeat(64));
  const identifier = 'transaction:ethereum:0xreconcile';
  const activity = {
    identifier,
    completedAtTimestamp: 0,
    metadata: {},
    status: 'success' as const,
    transfers: [],
    tokenIdentifiers: [],
    fee: { amount: 0, feePayer: [] },
    balanceChanges: [],
  };
  const job = (poll: number, state: string) => {
    const id = randomUUID();
    let retried: string | undefined;
    let promoted = false;
    let currentState = state;
    return {
      id,
      name: 'activity.check-finality',
      data: auth.seal({ type: 'activity.check-finality', activity, poll }, id),
      getState: async () => currentState,
      retry: async (finishedState: string) => {
        retried = finishedState;
      },
      promote: async () => {
        promoted = true;
        currentState = 'waiting';
      },
      read: () => ({ retried, promoted }),
    };
  };

  const older = job(3, 'delayed');
  const latest = job(5, 'completed');
  const completedQueue = { getJobs: async () => [older, latest] } as never;
  assert.equal(
    await reconcileActivity(completedQueue, identifier, auth),
    'Queued finality reconciliation at poll 5',
  );
  assert.equal(latest.read().retried, 'completed');
  assert.equal(older.read().promoted, false);

  const delayed = job(6, 'delayed');
  const delayedQueue = { getJobs: async () => [delayed] } as never;
  assert.equal(
    await reconcileActivity(delayedQueue, identifier, auth),
    'Queued finality reconciliation at poll 6',
  );
  assert.equal(delayed.read().promoted, true);
});

test('activity reconciliation searches paginated delayed jobs beyond the first 10000', async () => {
  const auth = new MessageAuth('e'.repeat(64));
  const identifier = 'transaction:ethereum:0xdeep';
  const activity = {
    identifier,
    completedAtTimestamp: 0,
    metadata: {},
    status: 'success' as const,
    transfers: [],
    tokenIdentifiers: [],
    fee: { amount: 0, feePayer: [] },
    balanceChanges: [],
  };
  const targetId = randomUUID();
  let promoted = false;
  const target = {
    id: targetId,
    name: 'activity.check-finality',
    data: auth.seal({ type: 'activity.check-finality', activity, poll: 12 }, targetId),
    getState: async () => 'delayed',
    promote: async () => {
      promoted = true;
    },
  };
  const requestedDelayedPages: number[] = [];
  const queue = {
    getJobs: async (states: string[], start: number, end: number) => {
      if (!states.includes('delayed')) return [];
      requestedDelayedPages.push(start);
      if (start === 10000) return [target];
      const count = Math.min(end - start + 1, 10000 - start);
      return Array.from({ length: count }, (_, index) => ({
        id: `unrelated-${start + index}`,
        name: 'unknown',
        data: {},
      }));
    },
  } as unknown as Queue;

  assert.equal(
    await reconcileActivity(queue, identifier, auth),
    'Queued finality reconciliation at poll 12',
  );
  assert.equal(promoted, true);
  assert(requestedDelayedPages.includes(10000));
});

test(
  'activity reconciliation requeues a completed BullMQ finality check',
  { skip: !process.env.TEST_REDIS_URL, timeout: 10000 },
  async () => {
    const prefix = `activity-reconcile-${randomUUID()}`;
    const options = { connection: connection(process.env.TEST_REDIS_URL!), prefix };
    const queue = new Queue(QUEUES.activity, options);
    const worker = new Worker(QUEUES.activity, async () => undefined, options);
    const auth = new MessageAuth('e'.repeat(64));
    const identifier = `transaction:ethereum:${randomUUID()}`;
    const activity = {
      identifier,
      completedAtTimestamp: 1,
      metadata: {},
      status: 'success' as const,
      transfers: [],
      tokenIdentifiers: [],
      fee: { amount: 0, feePayer: [] },
      balanceChanges: [],
    };
    const jobId = randomUUID();
    try {
      await worker.waitUntilReady();
      const job = await queue.add(
        'activity.check-finality',
        auth.seal({ type: 'activity.check-finality', activity, poll: 5 }, jobId),
        { jobId },
      );
      const deadline = Date.now() + 5000;
      while ((await job.getState()) !== 'completed' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(await job.getState(), 'completed');
      await worker.close();

      assert.equal(
        await reconcileActivity(queue, identifier, auth),
        'Queued finality reconciliation at poll 5',
      );
      assert.equal(await job.getState(), 'waiting');

      const delayedIdentifier = `transaction:ethereum:${randomUUID()}`;
      const delayedJobId = randomUUID();
      const delayedJob = await queue.add(
        'activity.check-finality',
        auth.seal(
          {
            type: 'activity.check-finality',
            activity: { ...activity, identifier: delayedIdentifier },
            poll: 6,
          },
          delayedJobId,
        ),
        { jobId: delayedJobId, delay: 60000 },
      );
      assert.equal(await delayedJob.getState(), 'delayed');
      assert.equal(
        await reconcileActivity(queue, delayedIdentifier, auth),
        'Queued finality reconciliation at poll 6',
      );
      assert.equal(await delayedJob.getState(), 'waiting');
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  },
);
