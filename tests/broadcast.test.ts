import { acceptanceRollout } from './helpers/rollout-fixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Job, Queue } from 'bullmq';
import { BroadcastPrismaService } from '../apps/broadcast/src/prisma/prisma.service.js';
import { migrate } from '../scripts/migrate.js';
import { BroadcastService } from '../apps/broadcast/src/broadcast/broadcast.service.js';
import { BroadcastProcessor } from '../apps/broadcast/src/broadcast/broadcast.processor.js';
import { BroadcastRpcService } from '../apps/broadcast/src/broadcast/broadcast-rpc.service.js';
import { OutboxRelay, enqueue } from '../packages/queue/src/outbox.service.js';
import { MessageAuth, Message, QUEUES } from '../packages/queue/src/messages.js';

const enabled = !!process.env.TEST_BROADCAST_DATABASE_URL;
const db = enabled
  ? new BroadcastPrismaService({ databaseUrl: process.env.TEST_BROADCAST_DATABASE_URL! })
  : undefined;
const ids: string[] = [];
const auth = new MessageAuth('b'.repeat(64));
const signed = { raw: '0x1234', txHash: '0x' + 'ab'.repeat(32), encoding: 'hex' as const };
const config = {
  allowBroadcast: true,
  ethereumChainId: '11155111',
  solanaGenesisHash: 'devnet',
  pollIntervalMs: 30000,
  maxPolls: 2,
};
before(async () => {
  if (db) await migrate(process.env.TEST_BROADCAST_DATABASE_URL!, 'broadcast');
});
after(async () => {
  if (db) {
    const txs = await db.transaction.findMany({ where: { id: { in: ids } } });
    await db.outbox.deleteMany({
      where: { OR: txs.map((t) => ({ dedupe_key: { contains: t.id } })) },
    });
    await db.transaction.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
const snapshot = { chain: 'ethereum' as const, network: '11155111', signed };

async function fixture() {
  const id = randomUUID();
  ids.push(id);
  return db!.transaction.create({
    data: {
      id,
      snapshot,
      status: 'queued',
      broadcast_generation: 1,
    },
  });
}

function job(message: Message, attemptsMade = 0) {
  const id = randomUUID();
  return {
    id,
    name: message.type,
    data: auth.seal(message, id),
    attemptsMade,
    opts: { attempts: 8 },
  } as unknown as Job;
}

function worker(rpc: Partial<BroadcastRpcService>, overrides: Partial<typeof config> = {}) {
  return new BroadcastProcessor(
    new BroadcastService(
      db as BroadcastPrismaService,
      rpc as BroadcastRpcService,
      {
        ...config,
        ...overrides,
      },
      undefined,
      acceptanceRollout,
    ),
    auth,
  );
}

test(
  'broadcast gate and retry exhaustion preserve signed bytes and publish attention events',
  { skip: !enabled },
  async () => {
    const tx = await fixture();
    let sends = 0;
    const rpc = {
      async status() {
        return 'unknown' as const;
      },
      async preflight() {},
      async broadcast() {
        sends++;
        throw new Error('timeout');
      },
    };
    const action = {
      type: 'broadcast.requested' as const,
      snapshot,
      transactionId: tx.id,
      generation: 1,
    };
    await assert.rejects(
      () => worker(rpc, { allowBroadcast: false }).process(job(action)),
      /disabled/,
    );
    assert.equal(sends, 0);
    assert.equal(
      (await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status,
      'attention',
    );
    await assert.rejects(() => worker(rpc).process(job(action, 7)), /operation failed/);
    const result = await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    assert.equal(result.status, 'attention');
    assert.equal(result.broadcast_attempts, 1);
    assert.deepEqual(result.snapshot, snapshot);
    const events = await db!.outbox.findMany({
      where: { dedupe_key: { startsWith: `broadcast-result-${tx.id}-` } },
      orderBy: { created_at: 'asc' },
    });
    assert.equal((events.at(-1)!.payload as { status: string }).status, 'attention');
  },
);
test(
  'stale generation cannot submit; confirmed replay cannot regress state',
  { skip: !enabled },
  async () => {
    const tx = await fixture();
    let calls = 0;
    const instance = worker({
      async status() {
        calls++;
        return 'confirmed';
      },
      async broadcast() {
        throw new Error('must not send');
      },
    });
    await instance.process(
      job({ type: 'broadcast.requested', snapshot, transactionId: tx.id, generation: 0 }),
    );
    assert.equal(calls, 0);
    await instance.process(
      job({ type: 'broadcast.requested', snapshot, transactionId: tx.id, generation: 1 }),
    );
    assert.equal(calls, 1);
    await instance.process(
      job({ type: 'broadcast.requested', snapshot, transactionId: tx.id, generation: 1 }),
    );
    assert.equal(calls, 1);
    assert.equal(
      (await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status,
      'confirmed',
    );
    // A retry requested before the wallet sees finality must receive finality for its new generation.
    await instance.process(
      job({ type: 'broadcast.requested', snapshot, transactionId: tx.id, generation: 2 }),
    );
    assert.equal(calls, 1);
    const finalEvent = await db!.outbox.findFirstOrThrow({
      where: {
        dedupe_key: { startsWith: `broadcast-result-${tx.id}-2-` },
      },
    });
    assert.equal((finalEvent.payload as { status: string }).status, 'confirmed');
    await assert.rejects(
      () =>
        instance.process(
          job({
            type: 'broadcast.requested',
            snapshot: { ...snapshot, signed: { ...signed, raw: '0x5678' } },
            transactionId: tx.id,
            generation: 2,
          }),
        ),
      /immutable/,
    );
    assert.deepEqual(
      (await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } })).snapshot,
      snapshot,
    );
  },
);
test(
  'confirmation scheduling is durable and bounded; unknown outcome remains reserved',
  { skip: !enabled },
  async () => {
    const tx = await fixture();
    const instance = worker({
      async status() {
        return 'unknown';
      },
    });
    await instance.process(
      job({ type: 'broadcast.confirm', transactionId: tx.id, generation: 1, poll: 0 }),
    );
    const outbox = await db!.outbox.findUniqueOrThrow({
      where: { dedupe_key: `confirm-${tx.id}-1-1` },
    });
    assert.equal(outbox.published_at, null);
    assert(outbox.available_at.getTime() > Date.now());
    await assert.rejects(
      () =>
        instance.process(
          job({ type: 'broadcast.confirm', transactionId: tx.id, generation: 1, poll: 2 }),
        ),
      /exhausted/,
    );
    assert.equal(
      (await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status,
      'attention',
    );
  },
);
test(
  'outbox retries a lost Redis acknowledgement using the same job ID',
  { skip: !enabled },
  async () => {
    const tx = await fixture();
    await db!.$transaction((client) =>
      enqueue(
        client,
        QUEUES.broadcast,
        { type: 'broadcast.requested', snapshot, transactionId: tx.id, generation: 1 },
        `ack-${tx.id}`,
      ),
    );
    const ids: string[] = [];
    let fail = true;
    const queue = {
      async add(_name: string, _body: unknown, opts: { jobId: string }) {
        ids.push(opts.jobId);
        if (fail) throw new Error('lost acknowledgement');
      },
    } as unknown as Queue;
    const relay = new OutboxRelay(
      db as BroadcastPrismaService,
      auth,
      queue,
      queue,
      queue,
      queue,
      queue,
      { outboxIntervalMs: 500 },
    );
    await assert.rejects(() => relay.flush());
    assert.equal(
      (await db!.outbox.findUniqueOrThrow({ where: { dedupe_key: `ack-${tx.id}` } })).published_at,
      null,
    );
    fail = false;
    await relay.flush();
    assert.equal(ids[0], ids[1]);
    const future = await db!.outbox.findMany({ where: { published_at: null } });
    assert(
      future.every((row) => row.available_at.getTime() > Date.now()),
      'Future confirmation actions must not be published early',
    );
    assert(
      (await db!.outbox.findUniqueOrThrow({ where: { dedupe_key: `ack-${tx.id}` } })).published_at,
    );
  },
);
