import 'reflect-metadata';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import { BroadcastService } from '../apps/broadcast/src/broadcast/broadcast.service.js';
import { BroadcastRpcService } from '../apps/broadcast/src/broadcast/broadcast-rpc.service.js';
import { BroadcastPrismaService } from '../apps/broadcast/src/prisma/prisma.service.js';
import { BroadcastConfig } from '../apps/broadcast/src/config/broadcast.config.js';
import { Chain, SignedTransaction } from '../packages/shared/src/contracts.js';
import { RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import { bitcoinBatchFixture } from './helpers/bitcoin-batch-fixture.js';
import { testMnemonic, isolatedDatabase } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';
import {
  signBitcoinBatchAuthorization,
  bitcoinBatchSignSchema,
} from '../packages/shared/src/bitcoin-batch-contracts.js';
import { broadcastSnapshotSchema } from '../packages/queue/src/messages.js';
import {
  executionDigest,
  signSignerAttestation,
} from '../packages/shared/src/execution-authorization.js';

const database = process.env.TEST_BROADCAST_DATABASE_URL;
const authority = generateKeyPairSync('ed25519'),
  attestor = generateKeyPairSync('ed25519');
let core: SigningCore;
before(async () => {
  core = await SigningCore.create(testMnemonic, 'batch-broadcast', '11155111', undefined, {
    domainId: 'exchange',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  });
});
after(() => core.close());

class Rpc extends BroadcastRpcService {
  sent: SignedTransaction[] = [];
  included = false;
  loseResponse = false;
  preflights = 0;
  constructor() {
    super({
      ethereumChainId: 'unused',
      solanaGenesisHash: 'unused',
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
  }

  override async call(_chain: Chain, method: string, _params: unknown[]): Promise<unknown> {
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    if (method === 'getrawtransaction') {
      const last = this.sent.at(-1);
      if (!last) throw new RpcFailure(-5);
      return {
        txid: last.txHash,
        hex: last.raw,
        ...(this.included ? { blockhash: 'c'.repeat(64) } : {}),
      };
    }
    if (method === 'getblockheader') return { hash: 'c'.repeat(64), height: 101, confirmations: 6 };
    if (method === 'getblockhash') return 'c'.repeat(64);
    throw new Error(`Unexpected batch broadcast RPC ${method}`);
  }

  override async preflight(_chain: Chain, _signed: SignedTransaction) {
    this.preflights++;
  }

  override async broadcast(_chain: Chain, signed: SignedTransaction) {
    this.sent.push(signed);
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new RpcFailure();
    }
  }
}

async function fixture() {
  const isolated = await isolatedDatabase(database!, 'broadcast'),
    db = new BroadcastPrismaService({ databaseUrl: isolated.url });
  try {
    const f = await bitcoinBatchFixture(core, 'exchange', 'epoch'),
      transactionId = randomUUID();
    const settings = {
      enabled: true,
      withdrawalsEnabled: true,
      bitcoinBatchesEnabled: true,
      domainId: 'exchange',
      resetEpoch: 'epoch',
      authorityPublicKey: authority.publicKey,
      attestationPrivateKey: attestor.privateKey,
    };
    const signed = new SigningService(core, new CustodySigningPolicy(settings, core)).execute(
      bitcoinBatchSignSchema.parse({
        type: 'payout.batch.sign',
        batchId: f.manifest.batchId,
        transactionId,
        manifest: f.manifest,
        preparation: f.preparation,
        authorization: signBitcoinBatchAuthorization(
          {
            version: 1,
            purpose: 'bitcoin_withdrawal_batch',
            domainId: 'exchange',
            resetEpoch: 'epoch',
            seedId: core.seedId,
            batchId: f.manifest.batchId,
            transactionId,
            manifestDigest: f.preparation.manifestDigest,
            preparationDigest: f.preparation.preparationDigest,
            sourcePath: f.source.path,
            expiresAt: f.preparation.expiresAt,
          },
          authority.privateKey,
        ),
      }),
    );
    if (signed.type !== 'payout.batch.signed') throw new Error('Expected signed fixture');
    const snapshot = broadcastSnapshotSchema.parse({
      chain: 'bitcoin',
      network: 'regtest',
      signed: signed.signed,
      execution: {
        domainId: 'exchange',
        resetEpoch: 'epoch',
        operationId: f.manifest.batchId,
        attemptId: f.manifest.batchId,
        requestDigest: f.preparation.manifestDigest,
        preparationDigest: f.preparation.preparationDigest,
        preparedRequest: f.preparation.request,
        bitcoinBatch: { manifest: f.manifest, preparation: f.preparation },
        signerAttestation: signed.signerAttestation,
      },
    });
    const rpc = new Rpc();
    const config: BroadcastConfig = {
      allowBroadcast: true,
      ethereumChainId: 'unused',
      solanaGenesisHash: 'unused',
      pollIntervalMs: 1000,
      maxPolls: 5,
      custodyMode: true,
      nativeWithdrawalsEnabled: true,
      bitcoinBatchesEnabled: true,
      domainId: 'exchange',
      resetEpoch: 'epoch',
      executionSignerPublicKey: attestor.publicKey,
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    };
    const worker = (overrides: Partial<BroadcastConfig> = {}) =>
      new BroadcastService(db, rpc, { ...config, ...overrides }, undefined, acceptanceRollout);
    const action = { type: 'broadcast.requested' as const, transactionId, generation: 1, snapshot };
    return {
      db,
      rpc,
      worker,
      action,
      f,
      close: async () => {
        await db.$disconnect();
        await isolated.drop();
      },
    };
  } catch (error) {
    await db.$disconnect();
    await isolated.drop();
    throw error;
  }
}

test(
  'batch broadcast retains exact signed snapshot across lost submission response and canonically confirms all outputs',
  { skip: !database },
  async () => {
    const f = await fixture();
    try {
      f.rpc.loseResponse = true;
      await assert.rejects(f.worker().execute(f.action, false));
      await f.worker().execute(f.action, false);
      assert.equal(f.rpc.sent.length, 2);
      assert.deepEqual(f.rpc.sent[0], f.rpc.sent[1]);
      f.rpc.included = true;
      await f.worker().execute(
        {
          type: 'broadcast.confirm',
          transactionId: f.action.transactionId,
          generation: 1,
          poll: 0,
        },
        false,
      );
      const row = await f.db.transaction.findUniqueOrThrow({
        where: { id: f.action.transactionId },
      });
      assert.equal(row.status, 'confirmed');
      assert.equal(row.actual_fee_units, f.f.preparation.feeUnits);
      assert.deepEqual(row.snapshot, f.action.snapshot);
    } finally {
      await f.close();
    }
  },
);

test(
  'batch broadcast rejects independent output mutations even with a fresh valid attestation, and stays separately disabled',
  { skip: !database },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.worker({ bitcoinBatchesEnabled: false }).execute(f.action, false));
      const changed = structuredClone(f.action);
      const request = structuredClone(f.f.preparation.request);
      assert(request.transaction.chain === 'bitcoin');
      request.transaction.outputs[1].address = core.derive({
        chain: 'bitcoin',
        seedId: core.seedId,
        account: 11,
      }).address;
      changed.snapshot.signed = core.sign(request);
      const execution = changed.snapshot.execution!;
      const unsigned = {
        type: 'transaction.custody.signed',
        transactionId: changed.transactionId,
        operationId: execution.operationId,
        attemptId: execution.attemptId,
        requestDigest: execution.requestDigest,
        preparationDigest: execution.preparationDigest,
        signed: changed.snapshot.signed,
      };
      execution.signerAttestation = signSignerAttestation(
        {
          version: 1,
          domainId: 'exchange',
          resetEpoch: 'epoch',
          transactionId: changed.transactionId,
          operationId: execution.operationId,
          attemptId: execution.attemptId,
          requestDigest: execution.requestDigest,
          preparationDigest: execution.preparationDigest,
          status: 'signed',
          resultDigest: executionDigest(unsigned),
        },
        attestor.privateKey,
      );
      await assert.rejects(f.worker().execute(changed, false));
      assert.equal(f.rpc.sent.length, 0);
      assert.equal(await f.db.transaction.count(), 0);
    } finally {
      await f.close();
    }
  },
);
