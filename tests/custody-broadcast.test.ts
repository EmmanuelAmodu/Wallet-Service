import { signSchema } from '../packages/shared/src/contracts.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { BroadcastPrismaService } from '../apps/broadcast/src/prisma/prisma.service.js';
import { BroadcastService } from '../apps/broadcast/src/broadcast/broadcast.service.js';
import { BroadcastRpcService } from '../apps/broadcast/src/broadcast/broadcast-rpc.service.js';
import { broadcastConfig, BroadcastConfig } from '../apps/broadcast/src/config/broadcast.config.js';
import {
  NativeSweepPlanner,
  NativeSweepObservation,
} from '../packages/chain/src/native-sweep-planner.js';
import { broadcastSnapshotSchema, Message } from '../packages/queue/src/messages.js';
import {
  executionDigest,
  executionRequestDigest,
  signSignerAttestation,
} from '../packages/shared/src/execution-authorization.js';
import { SignRequest } from '../packages/shared/src/contracts.js';
import { migrate } from '../scripts/migrate.js';
import { devnet } from './helpers/custody-fixture.js';
import { z } from 'zod';

const enabled = !!process.env.TEST_BROADCAST_DATABASE_URL;
const signer = generateKeyPairSync('ed25519');
const config: BroadcastConfig = {
  allowBroadcast: true,
  ethereumChainId: '11155111',
  solanaGenesisHash: devnet,
  pollIntervalMs: 30000,
  maxPolls: 2,
  nativeSweepsEnabled: true,
  custodyMode: true,
  domainId: 'broadcast-test-exchange',
  resetEpoch: 'broadcast-test-epoch',
  executionSignerPublicKey: signer.publicKey,
};
let db: BroadcastPrismaService;
let databaseName: string;

before(async () => {
  if (!enabled) return;
  const source = process.env.TEST_BROADCAST_DATABASE_URL!;
  databaseName = `waas_broadcast_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: source });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  await migrate(url.toString(), 'broadcast');
  db = new BroadcastPrismaService({ databaseUrl: url.toString() });
});
after(async () => {
  if (!enabled || !databaseName) return;
  if (db) await db.$disconnect();
  const admin = new Client({ connectionString: process.env.TEST_BROADCAST_DATABASE_URL! });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

type Snapshot = z.infer<typeof broadcastSnapshotSchema>;

function fixture(chain: 'ethereum' | 'solana' = 'ethereum') {
  const transactionId = randomUUID();
  const network = chain === 'ethereum' ? '11155111' : devnet;
  const request: SignRequest =
    chain === 'ethereum'
      ? {
          wallet: {
            chain,
            account: 10,
            seedId: 'exchange-test-seed',
            address: '0x' + '11'.repeat(20),
            network,
          },
          transaction: {
            chain,
            chainId: network,
            nonce: '0',
            to: '0x' + '22'.repeat(20),
            amount: '10000000000000000',
            gasLimit: '21000',
            maxFeePerGas: '1000000000',
            maxPriorityFeePerGas: '1000000000',
          },
        }
      : {
          wallet: {
            chain,
            account: 10,
            seedId: 'exchange-test-seed',
            address: '3'.repeat(32),
            network,
          },
          transaction: {
            chain,
            outputs: [{ address: '4'.repeat(32), amount: '1000000' }],
            recentBlockhash: '5'.repeat(32),
            lastValidBlockHeight: 100,
          },
        };
  const signed =
    chain === 'ethereum'
      ? { raw: '0x1234', txHash: '0x' + 'ab'.repeat(32), encoding: 'hex' as const }
      : {
          raw: Buffer.alloc(100, 1).toString('base64'),
          txHash: '6'.repeat(88),
          encoding: 'base64' as const,
        };
  const binding = {
    operationId: randomUUID(),
    attemptId: randomUUID(),
    requestDigest: executionDigest({ transactionId }),
    preparationDigest: executionRequestDigest(request),
  };
  const result = { type: 'transaction.custody.signed', transactionId, ...binding, signed };
  const signerAttestation = signSignerAttestation(
    {
      version: 1,
      domainId: config.domainId!,
      resetEpoch: config.resetEpoch!,
      transactionId,
      ...binding,
      status: 'signed',
      resultDigest: executionDigest(result),
    },
    signer.privateKey,
  );
  const snapshot: Snapshot = {
    chain,
    network,
    signed,
    ...(chain === 'solana' ? { lastValidBlockHeight: 100 } : {}),
    execution: {
      ...binding,
      domainId: config.domainId!,
      resetEpoch: config.resetEpoch!,
      preparedRequest: request,
      signerAttestation,
    },
  };
  const action = { type: 'broadcast.requested' as const, transactionId, generation: 1, snapshot };
  return { transactionId, snapshot, action };
}

function worker(
  observe: () => Promise<NativeSweepObservation>,
  rpc: Partial<BroadcastRpcService> = {},
  overrides: Partial<BroadcastConfig> = {},
) {
  return new BroadcastService(
    db,
    {
      async status() {
        throw new Error('Legacy confirmation counts must not determine custody finality');
      },
      async preflight() {},
      async broadcast() {},
      ...rpc,
    } as BroadcastRpcService,
    { ...config, ...overrides },
    { observe } as unknown as NativeSweepPlanner,
  );
}

const included = {
  state: 'confirmed' as const,
  blockHash: '0x' + 'cd'.repeat(32),
  blockHeight: '100',
  actualFeeUnits: '21000000000000',
};

test(
  'custody broadcast uses canonical finality, stores actual fees and emits bound results',
  { skip: !enabled },
  async () => {
    const f = fixture();
    let sends = 0;
    const service = worker(async () => included, {
      async broadcast() {
        sends++;
      },
    });
    await service.execute(f.action, false);
    assert.equal(sends, 0);
    const stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'confirmed');
    assert.equal(stored.actual_fee_units, included.actualFeeUnits);
    assert.equal(stored.observed_block_hash, included.blockHash);
    assert.equal(stored.observed_block_height, included.blockHeight);
    const rows = await db.outbox.findMany({
      where: { dedupe_key: { startsWith: `broadcast-result-${f.transactionId}-` } },
    });
    const result = rows.at(-1)!.payload as Extract<Message, { type: 'broadcast.updated' }>;
    const { operationId, attemptId, requestDigest, preparationDigest } = f.snapshot.execution!;
    assert.deepEqual(result.execution, {
      operationId,
      attemptId,
      requestDigest,
      preparationDigest,
    });
    assert.equal(result.status, 'confirmed');
    await service.execute({ ...f.action, generation: 2 }, false);
    assert.equal(
      (await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } })).status,
      'confirmed',
    );
  },
);

test(
  'a lost send response reconciles the same signed attempt before any resend',
  { skip: !enabled },
  async () => {
    const f = fixture();
    let calls = 0;
    const sent: unknown[] = [];
    const service = worker(async () => (++calls === 1 ? { state: 'pending' } : included), {
      async broadcast(_chain, signed) {
        sent.push(signed);
        throw new Error('RPC accepted but response was lost');
      },
    });
    await assert.rejects(service.execute(f.action, false), /operation failed/);
    await service.execute(f.action, false);
    assert.deepEqual(sent, [f.snapshot.signed]);
    assert.equal(
      (await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } })).status,
      'confirmed',
    );
  },
);

test(
  'queue producer cannot substitute signed bytes, preparation, attempt or custody identity',
  { skip: !enabled },
  async () => {
    for (const mutation of [
      (s: Snapshot) => {
        s.signed.raw = '0x5678';
      },
      (s: Snapshot) => {
        s.execution!.attemptId = randomUUID();
      },
      (s: Snapshot) => {
        s.execution!.domainId = 'another-domain';
      },
      (s: Snapshot) => {
        s.execution!.resetEpoch = 'stale-epoch';
      },
      (s: Snapshot) => {
        s.execution!.preparedRequest.wallet.account = 11;
      },
      (s: Snapshot) => {
        s.execution!.signerAttestation.signature = 'a'.repeat(86);
      },
    ]) {
      const f = fixture();
      mutation(f.snapshot);
      let calls = 0;
      await assert.rejects(
        worker(async () => {
          calls++;
          return included;
        }).execute(f.action, false),
        /attestation/,
      );
      assert.equal(calls, 0);
      assert.equal(await db.transaction.findUnique({ where: { id: f.transactionId } }), null);
    }
    const f = fixture();
    await assert.rejects(
      worker(async () => included).execute({ ...f.action, transactionId: randomUUID() }, false),
      /attestation/,
    );
  },
);

test(
  'native mode rejects unauthenticated legacy snapshots and disabled mode rejects custody snapshots',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const { execution: _execution, ...legacy } = f.snapshot;
    await assert.rejects(
      worker(async () => included).execute({ ...f.action, snapshot: legacy }, false),
      /attested/,
    );
    await assert.rejects(
      worker(async () => included, {}, { nativeSweepsEnabled: false, custodyMode: true }).execute(
        { ...f.action, snapshot: legacy },
        false,
      ),
      /attested/,
    );
    await assert.rejects(
      worker(async () => included, {}, { nativeSweepsEnabled: false }).execute(f.action, false),
      /disabled/,
    );
    assert.equal(await db.transaction.findUnique({ where: { id: f.transactionId } }), null);
  },
);

test('configured exchange custody mode stays active while native execution is disabled', () => {
  const values = {
    EXCHANGE_DOMAIN_ID: 'custody-disabled-feature',
    ENABLE_NATIVE_SWEEPS: 'false',
    ALLOW_BROADCAST: 'false',
    ETH_CHAIN_ID: '11155111',
    SOLANA_GENESIS_HASH: devnet,
    BROADCAST_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5433/unused',
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const settings = broadcastConfig();
    assert.equal(settings.custodyMode, true);
    assert.equal(settings.domainId, values.EXCHANGE_DOMAIN_ID);
    assert.equal(settings.nativeSweepsEnabled, false);
    assert.equal(settings.executionSignerPublicKey, undefined);
    delete process.env.EXCHANGE_DOMAIN_ID;
    assert.equal(broadcastConfig().custodyMode, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test(
  'retry generations preserve bytes and database guards pin complete execution identities',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const sent: unknown[] = [];
    const service = worker(async () => ({ state: 'pending' }), {
      async broadcast(_chain, signed) {
        sent.push(signed);
      },
    });
    await service.execute(f.action, false);
    await service.execute({ ...f.action, generation: 0 }, false);
    assert.equal(sent.length, 1);
    const altered = structuredClone(f.snapshot);
    altered.signed.raw = '0x5678';
    await assert.rejects(
      service.execute({ ...f.action, snapshot: altered, generation: 2 }, false),
      /immutable/,
    );
    await service.execute({ ...f.action, generation: 2 }, false);
    assert.deepEqual(sent, [f.snapshot.signed, f.snapshot.signed]);
    await assert.rejects(
      db.transaction.update({ where: { id: f.transactionId }, data: { snapshot: altered } }),
    );
    await assert.rejects(
      db.transaction.update({
        where: { id: f.transactionId },
        data: { operation_id: randomUUID() },
      }),
    );
    await assert.rejects(
      db.transaction.create({
        data: {
          id: randomUUID(),
          snapshot: { ...f.snapshot, execution: {} },
          status: 'queued',
          broadcast_generation: 1,
          operation_id: randomUUID(),
          attempt_id: randomUUID(),
          domain_id: config.domainId,
          reset_epoch: config.resetEpoch,
          request_digest: 'a'.repeat(64),
          preparation_digest: 'b'.repeat(64),
        },
      }),
    );
    assert.deepEqual(
      (await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } })).snapshot,
      f.snapshot,
    );
  },
);

test(
  'expired Solana attempts remain in attention with immutable bytes and no automatic resigning',
  { skip: !enabled },
  async () => {
    const f = fixture('solana');
    let sends = 0;
    const service = worker(async () => ({ state: 'pending' }), {
      async call() {
        return 101;
      },
      async broadcast() {
        sends++;
      },
    });
    await assert.rejects(service.execute(f.action, false), /expired/);
    await assert.rejects(service.execute({ ...f.action, generation: 2 }, false), /expired/);
    assert.equal(sends, 0);
    const stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'attention');
    assert.deepEqual(stored.snapshot, f.snapshot);
  },
);

test(
  'RPC outages and proven reorgs preserve prior canonical evidence for authoritative reconciliation',
  { skip: !enabled },
  async () => {
    const f = fixture();
    let state: 'pending' | 'outage' | 'reverted' = 'pending';
    const inputs: unknown[] = [];
    const planner = {
      async observe(input: unknown) {
        inputs.push(input);
        if (state === 'outage') throw new Error('Provider unavailable');
        if (state === 'reverted') return { state: 'reverted' as const };
        return { ...included, state: 'pending' as const };
      },
    } as unknown as NativeSweepPlanner;
    const service = new BroadcastService(db, {} as BroadcastRpcService, config, planner);
    await service.execute(f.action, false);
    state = 'outage';
    const confirm = {
      type: 'broadcast.confirm' as const,
      transactionId: f.transactionId,
      generation: 1,
      poll: 1,
    };
    await assert.rejects(service.execute(confirm, true), /operation failed/);
    let stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'attention');
    assert.equal(stored.observed_block_hash, included.blockHash);
    assert.equal(stored.actual_fee_units, included.actualFeeUnits);
    state = 'reverted';
    await assert.rejects(service.execute(confirm, false), /reverted/);
    stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'attention');
    assert.equal(stored.observed_block_hash, included.blockHash);
    assert.deepEqual((inputs.at(-1) as { priorInclusion: unknown }).priorInclusion, {
      blockHash: included.blockHash,
      blockHeight: included.blockHeight,
    });
  },
);

test(
  'incomplete finality evidence cannot release monitoring or report a terminal result',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const service = worker(async () => ({
      state: 'confirmed',
      blockHash: included.blockHash,
      blockHeight: '100',
    }));
    await assert.rejects(service.execute(f.action, true), /operation failed/);
    assert.equal(
      (await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } })).status,
      'attention',
    );
    await assert.rejects(
      db.transaction.update({ where: { id: f.transactionId }, data: { status: 'confirmed' } }),
    );
  },
);

test(
  'canonical on-chain failure preserves its fee and stops immutable retries',
  { skip: !enabled },
  async () => {
    const f = fixture();
    let observations = 0;
    let sends = 0;
    const service = worker(
      async () => {
        observations++;
        return { ...included, state: 'failed' };
      },
      {
        async broadcast() {
          sends++;
        },
      },
    );
    await service.execute(f.action, false);
    await service.execute({ ...f.action, generation: 2 }, false);
    const stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'failed');
    assert.equal(stored.actual_fee_units, included.actualFeeUnits);
    assert.equal(observations, 1);
    assert.equal(sends, 0);
  },
);

test(
  'custody confirmation exhaustion and unrelated signer keys cannot release an unknown attempt',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const unrelated = generateKeyPairSync('ed25519');
    await assert.rejects(
      worker(async () => included, {}, { executionSignerPublicKey: unrelated.publicKey }).execute(
        f.action,
        false,
      ),
      /attestation/,
    );
    const service = worker(async () => ({ state: 'pending' }));
    await service.execute(f.action, false);
    await assert.rejects(
      service.execute(
        { type: 'broadcast.confirm', transactionId: f.transactionId, generation: 1, poll: 2 },
        false,
      ),
      /exhausted/,
    );
    const stored = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(stored.status, 'attention');
    assert.deepEqual(stored.snapshot, f.snapshot);
    assert.equal(stored.actual_fee_units, null);
    const scheduled = await db.outbox.findUniqueOrThrow({
      where: { dedupe_key: `confirm-${f.transactionId}-1-0` },
    });
    assert.equal(scheduled.published_at, null);
    assert(scheduled.available_at.getTime() > Date.now());
  },
);

test(
  'native withdrawal broadcasting has an independent enablement gate and preserves attested hot0 bytes',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const execution = f.snapshot.execution!;
    execution.preparedRequest.wallet.account = 0;
    execution.preparationDigest = executionRequestDigest(signSchema.parse(execution.preparedRequest));
    const body = {
      type: 'transaction.custody.signed',
      transactionId: f.transactionId,
      operationId: execution.operationId,
      attemptId: execution.attemptId,
      requestDigest: execution.requestDigest,
      preparationDigest: execution.preparationDigest,
      signed: f.snapshot.signed,
    };
    execution.signerAttestation = signSignerAttestation(
      {
        ...execution.signerAttestation.claims,
        preparationDigest: execution.preparationDigest,
        resultDigest: executionDigest(body),
      },
      signer.privateKey,
    );
    await assert.rejects(worker(async () => included).execute(f.action, false), /disabled/);
    let sent = 0;
    let observation: NativeSweepObservation = { state: 'pending' };
    const service = worker(
      async () => observation,
      {
        async status() {
          return 'unknown';
        },
        async broadcast(_chain, raw) {
          assert.equal(raw.raw, f.snapshot.signed.raw);
          sent++;
        },
      },
      { nativeSweepsEnabled: false, nativeWithdrawalsEnabled: true },
    );
    await service.execute(f.action, false);
    assert.equal(sent, 1);
    const saved = await db.transaction.findUniqueOrThrow({ where: { id: f.transactionId } });
    assert.equal(saved.operation_id, execution.operationId);
    observation = included;
    await service.execute(f.action, false);
    assert.equal(sent, 1);
  },
);
