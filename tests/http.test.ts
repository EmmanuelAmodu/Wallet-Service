import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Transaction as EthTransaction } from 'ethers';
import { Queue } from 'bullmq';
import { createDatabase } from '../packages/database/src/client';
import { migrate } from '../scripts/migrate';
import { connection } from '../packages/queue/src/module';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages';

async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 15000,
) {
  const started = Date.now();
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() - started < timeout);
  throw new Error('Timed out waiting for state: ' + JSON.stringify(last));
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((r) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      r();
    });
    child.kill('SIGTERM');
  });
}

test(
  'HTTP + Redis + Prisma: offline workers, async signing, retries, lost response reconciliation, replicas and confirmations',
  { skip: !process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL, timeout: 60000 },
  async () => {
    const db = createDatabase(process.env.TEST_DATABASE_URL!);
    await migrate(process.env.TEST_DATABASE_URL!);
    const dir = await mkdtemp(join(tmpdir(), 'waas-events-')),
      seed = join(dir, 'seed');
    await writeFile(
      seed,
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      { mode: 0o600 },
    );
    const tenant = randomUUID(),
      apiKey = 'a'.repeat(64),
      queueKey = 'b'.repeat(64),
      prefix = `test-${randomUUID()}`,
      walletPort = await freePort();
    const raws: string[] = [];
    let accepted = false,
      confirmed = false;
    const rpc = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      let result: unknown;
      switch (body.method) {
        case 'eth_chainId':
          result = '0xaa36a7';
          break;
        case 'eth_getTransactionCount':
          result = '0x0';
          break;
        case 'eth_estimateGas':
          result = '0x5208';
          break;
        case 'eth_getBalance':
          result = '0xffffffffffffffff';
          break;
        case 'eth_getTransactionByHash':
          result = accepted ? { hash: body.params[0] } : null;
          break;
        case 'eth_getTransactionReceipt':
          result = confirmed ? { blockNumber: '0xa', status: '0x1' } : null;
          break;
        case 'eth_blockNumber':
          result = '0x15';
          break;
        case 'eth_sendRawTransaction':
          raws.push(body.params[0]);
          if (raws.length === 1) {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'temporary failure' },
              }),
            );
            return;
          }
          accepted = true;
          req.socket.destroy();
          return;
        default:
          throw new Error('Unexpected RPC method');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
    const env = {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      REDIS_URL: process.env.TEST_REDIS_URL,
      QUEUE_PREFIX: prefix,
      QUEUE_AUTH_KEY: queueKey,
      SIGNER_SEED_FILE: seed,
      SIGNER_SEED_ID: 'http-events',
      ETH_CHAIN_ID: '11155111',
      SOLANA_GENESIS_HASH: 'devnet',
      WALLET_PORT: String(walletPort),
      WALLET_HOST: '127.0.0.1',
      WALLET_API_KEYS: JSON.stringify({ [tenant]: apiKey }),
      ETH_RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`,
      ALLOW_BROADCAST: 'true',
      OUTBOX_INTERVAL_MS: '50',
      QUEUE_RETRY_DELAY_MS: '100',
      CONFIRMATION_POLL_MS: '100',
      CONFIRMATION_MAX_POLLS: '100',
    };
    const children: ChildProcess[] = [];
    let logs = '';
    function start(name: string, overrides: Record<string, string> = {}) {
      const child = spawn(process.execPath, [resolve(`dist/apps/${name}/src/main.js`)], {
        env: { ...env, ...overrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (b) => {
        logs += b;
      });
      child.stderr?.on('data', (b) => {
        logs += b;
      });
      children.push(child);
      return child;
    }
    const queues = Object.values(QUEUES).map(
      (name) => new Queue(name, { connection: connection(process.env.TEST_REDIS_URL!), prefix }),
    );
    const base = `http://127.0.0.1:${walletPort}`;
    const request = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      start('wallet');
      await eventually(
        async () => {
          try {
            return (await fetch(base)).status;
          } catch {
            return 0;
          }
        },
        (s) => s === 401,
      );
      const created = await request('/v1/wallets', { chain: 'ethereum', externalId: 'alice' });
      assert.equal(created.status, 202);
      const wallet = (await created.json()) as { id: string; status: string; address: string };
      assert.equal(wallet.status, 'deriving');
      await eventually(
        () => queues.find((q) => q.name === QUEUES.signer)!.getWaitingCount(),
        (n) => n === 1,
      );
      assert.equal(
        (await db.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).status,
        'deriving',
      );
      start('signer');
      const ready = await eventually(
        () => db.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
        (w) => w.status === 'ready',
      );
      assert.match(ready.address!, /^0x[0-9a-fA-F]{40}$/);
      const invalid = await request(
        `/v1/wallets/${wallet.id}/transactions`,
        { chain: 'ethereum', amount: 'invalid' },
        { 'idempotency-key': 'invalid' },
      );
      assert.equal(invalid.status, 400);
      const intent = {
        chain: 'ethereum',
        to: ready.address,
        amount: '1',
        maxFeePerGas: '2',
        maxPriorityFeePerGas: '1',
      };
      const response = await request(`/v1/wallets/${wallet.id}/transactions`, intent, {
        'idempotency-key': 'payment-1',
      });
      assert.equal(response.status, 202);
      const tx = (await response.json()) as { id: string };
      const signed = await eventually(
        () => db.transaction.findUniqueOrThrow({ where: { id: tx.id } }),
        (t) => t.status === 'signed',
      );
      const bytes = (signed.signed as { raw: string }).raw;
      assert.equal(EthTransaction.from(bytes).from, ready.address);
      const duplicate = await request(`/v1/wallets/${wallet.id}/transactions`, intent, {
        'idempotency-key': 'payment-1',
      });
      assert.equal(((await duplicate.json()) as { id: string }).id, tx.id);
      const queued = await request(`/v1/transactions/${tx.id}/broadcast`, {});
      assert.equal(queued.status, 202);
      assert.equal(raws.length, 0);
      // Redis holds the command while the broadcast service is offline.
      await eventually(
        () => queues.find((q) => q.name === QUEUES.broadcast)!.getWaitingCount(),
        (n) => n === 1,
      );
      start('broadcast');
      start('broadcast');
      await eventually(
        () => db.transaction.findUniqueOrThrow({ where: { id: tx.id } }),
        (t) => t.status === 'submitted',
      );
      assert.equal(raws.length, 2);
      assert.equal(raws[0], raws[1]);
      assert.equal(raws[0], bytes);
      confirmed = true;
      const final = await eventually(
        () => db.transaction.findUniqueOrThrow({ where: { id: tx.id } }),
        (t) => t.status === 'confirmed',
      );
      assert.equal(final.broadcast_attempts, 3);
      // Replay a completed signing event after finality. State guards must not regress it.
      const signOutbox = await db.outbox.findUniqueOrThrow({
        where: { dedupe_key: `sign-${tx.id}` },
      });
      const resultId = `result-${signOutbox.id}`,
        queue = queues.find((q) => q.name === QUEUES.wallet)!;
      const old = await queue.getJob(resultId);
      assert(old);
      await old.remove();
      const auth = new MessageAuth(queueKey),
        payload = {
          type: 'transaction.signed' as const,
          transactionId: tx.id,
          signed: signed.signed as { raw: string; txHash: string; encoding: 'hex' },
        };
      await queue.add(payload.type, auth.seal(payload, resultId), { jobId: resultId });
      await eventually(
        async () => (await queue.getJob(resultId))?.getState(),
        (s) => s === 'completed',
      );
      assert.equal(
        (await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status,
        'confirmed',
      );
    } catch (error) {
      console.error(logs);
      throw error;
    } finally {
      await Promise.all(children.map(stop));
      await new Promise<void>((r) => rpc.close(() => r()));
      for (const queue of queues) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      const wallets = await db.wallet.findMany({ where: { tenant_id: tenant } }),
        txs = await db.transaction.findMany({ where: { tenant_id: tenant } });
      const ids = [...wallets, ...txs].map((x) => x.id);
      const outbox = await db.outbox.findMany({
        where: { OR: ids.map((id) => ({ dedupe_key: { contains: id } })) },
      });
      await db.inbox.deleteMany({ where: { id: { in: outbox.map((o) => `result-${o.id}`) } } });
      await db.outbox.deleteMany({ where: { id: { in: outbox.map((o) => o.id) } } });
      await db.transaction.deleteMany({ where: { tenant_id: tenant } });
      await db.wallet.deleteMany({ where: { tenant_id: tenant } });
      await db.$disconnect();
      await rm(dir, { recursive: true });
    }
  },
);
