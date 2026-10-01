import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Job, Queue } from 'bullmq';
import { Database, createDatabase } from '../packages/database/src/client';
import { migrate } from '../scripts/migrate';
import { BroadcastWorker } from '../apps/broadcast/src/worker';
import { BroadcastRpc } from '../apps/broadcast/src/rpc';
import { OutboxRelay, enqueue } from '../packages/queue/src/outbox';
import { MessageAuth, Message, QUEUES } from '../packages/queue/src/messages';

const enabled = !!process.env.TEST_DATABASE_URL;
const db = enabled ? createDatabase(process.env.TEST_DATABASE_URL!) : undefined;
const tenant = randomUUID(),
  auth = new MessageAuth('b'.repeat(64));
const signed = { raw: '0x1234', txHash: '0x' + 'ab'.repeat(32), encoding: 'hex' as const };
const config = {
  allowBroadcast: true,
  ethereumChainId: '11155111',
  solanaGenesisHash: 'devnet',
  pollIntervalMs: 30000,
  maxPolls: 2,
};
before(async () => {
  if (db) await migrate(process.env.TEST_DATABASE_URL!);
});
after(async () => {
  if (db) {
    const txs = await db.transaction.findMany({ where: { tenant_id: tenant } });
    await db.outbox.deleteMany({
      where: { OR: txs.map((t) => ({ dedupe_key: { contains: t.id } })) },
    });
    await db.transaction.deleteMany({ where: { tenant_id: tenant } });
    await db.wallet.deleteMany({ where: { tenant_id: tenant } });
    await db.$disconnect();
  }
});
async function fixture() {
  const [{ account }] = await db!.$queryRaw<
    { account: bigint }[]
  >`SELECT nextval('wallet_account_seq') AS account`;
  const wallet = await db!.wallet.create({
    data: {
      id: randomUUID(),
      tenant_id: tenant,
      external_id: randomUUID(),
      chain: 'ethereum',
      network: '11155111',
      seed_id: 'test',
      account: Number(account),
      path: `m/44'/60'/${account}'/0/0`,
      status: 'ready',
      address: '0x' + account.toString(16).padStart(40, '0'),
    },
  });
  return db!.transaction.create({
    data: {
      id: randomUUID(),
      tenant_id: tenant,
      wallet_id: wallet.id,
      idempotency_key: randomUUID(),
      request_hash: 'test',
      intent: { chain: 'ethereum' },
      signed,
      tx_hash: signed.txHash,
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
function worker(rpc: Partial<BroadcastRpc>, overrides: Partial<typeof config> = {}) {
  return new BroadcastWorker(db as Database, auth, rpc as BroadcastRpc, {
    ...config,
    ...overrides,
  });
}
test(
  'broadcast gate and retry exhaustion preserve signed bytes and wallet reservation',
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
    const action = { type: 'broadcast.requested' as const, transactionId: tx.id, generation: 1 };
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
    assert.deepEqual(result.signed, signed);
    await assert.rejects(() =>
      db!.transaction.create({
        data: {
          id: randomUUID(),
          wallet_id: tx.wallet_id,
          tenant_id: tenant,
          idempotency_key: randomUUID(),
          request_hash: 'test',
          intent: {},
          status: 'preparing',
        },
      }),
    );
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
      job({ type: 'broadcast.requested', transactionId: tx.id, generation: 0 }),
    );
    assert.equal(calls, 0);
    await instance.process(
      job({ type: 'broadcast.requested', transactionId: tx.id, generation: 1 }),
    );
    assert.equal(calls, 1);
    await instance.process(
      job({ type: 'broadcast.requested', transactionId: tx.id, generation: 1 }),
    );
    assert.equal(calls, 1);
    assert.equal(
      (await db!.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status,
      'confirmed',
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
        { type: 'broadcast.requested', transactionId: tx.id, generation: 1 },
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
    const relay = new OutboxRelay(db as Database, auth, queue, queue, queue);
    await assert.rejects(() => relay.flush());
    assert.equal(
      (await db!.outbox.findUniqueOrThrow({ where: { dedupe_key: `ack-${tx.id}` } })).published_at,
      null,
    );
    fail = false;
    await relay.flush();
    assert.equal(new Set(ids).size, 1);
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
