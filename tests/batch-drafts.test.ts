import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { BatchDraftsService } from '../apps/wallet/src/execution/batch-drafts.service.js';
import { MessageAuth } from '../packages/queue/src/messages.js';
import {
  payoutBatchManifestSchema,
  payoutBatchDigest,
} from '../packages/shared/src/payout-policy.js';
import { custodySettings, isolatedDatabase, testMnemonic } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { BitcoinBatchPlanner } from '../packages/chain/src/bitcoin-batch-planner.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { regtestWitnessAddress } from '../packages/chain/src/bitcoin-address.js';
import { Chain } from '../packages/shared/src/contracts.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  'unsigned Bitcoin preparation atomically retains exact mappings, fee shares and exclusive outpoints until whole-draft dissolution',
  { skip: !databaseUrl },
  async () => {
    const f = await fixture();
    try {
      await f.service.claim(f.manifest);
      const plan = await f.planner.plan(f.manifest);
      const data = {
        batch_id: f.manifest.batchId,
        preparation: plan,
        preparation_digest: plan.preparationDigest,
        expires_at: new Date(plan.expiresAt),
      };
      await assert.rejects(
        f.db.withdrawalBatchPreparation.create({ data }),
        /complete exact input reservations/,
      );
      assert.equal(await f.db.withdrawalBatchPreparation.count(), 0);
      const forged = structuredClone(plan);
      forged.request.transaction = {
        ...forged.request.transaction,
        chain: 'bitcoin',
        utxos: [],
        outputs: [],
        satsPerVbyte: 2,
      };
      await assert.rejects(
        f.db.withdrawalBatchPreparation.create({ data: { ...data, preparation: forged } }),
      );
      const before = await f.db.outbox.count();
      const row = await f.service.prepareBitcoin(f.manifest.batchId);
      assert.equal(
        (await f.service.prepareBitcoin(f.manifest.batchId)).preparation_digest,
        row.preparation_digest,
      );
      const retained = row.preparation as unknown as typeof plan;
      const { preparationDigest, ...body } = retained;
      assert.equal(executionDigest(body), preparationDigest);
      assert.deepEqual(
        retained.memberOutputs.map((m) => m.outputIndex),
        [0, 2, 3],
      );
      const resources = await f.db.withdrawalBatchResource.findMany({
        where: { batch_id: row.batch_id },
      });
      assert.equal(resources.length, 1);
      assert.equal(resources[0].active, true);
      await assert.rejects(
        f.db.withdrawalBatchPreparation.update({
          where: { batch_id: row.batch_id },
          data: { preparation: {} },
        }),
        /immutable/,
      );
      await assert.rejects(
        f.db.withdrawalBatchResource.update({
          where: {
            batch_id_resource_key: {
              batch_id: row.batch_id,
              resource_key: resources[0].resource_key,
            },
          },
          data: { active: false, released_at: new Date() },
        }),
        /only unsigned dissolution/,
      );
      assert.equal(await f.db.outbox.count(), before);
      const customerId = f.manifest.members[0].customerId;
      const otherSource = await f.db.$transaction((tx) =>
        f.custody.allocateCustomer(tx, customerId, 'ethereum', '11155111'),
      );
      const otherHot = await f.db.wallet.findFirstOrThrow({
        where: { chain: 'ethereum', custody_role: 'hot' },
      });
      const transaction = await f.db.transaction.create({
        data: {
          id: randomUUID(),
          wallet_id: otherSource.id,
          idempotency_key: randomUUID(),
          request_hash: 'a'.repeat(64),
          intent: {},
          status: 'preparing',
        },
      });
      const execution = await f.db.custodyExecution.create({
        data: {
          id: randomUUID(),
          operation_id: randomUUID(),
          attempt_id: randomUUID(),
          transaction_id: transaction.id,
          domain_id: f.manifest.domainId,
          reset_epoch: f.manifest.resetEpoch,
          customer_id: customerId,
          source_wallet_id: otherSource.id,
          hot_wallet_id: otherHot.id,
          request_digest: 'a'.repeat(64),
          plan: { type: 'sweep.plan.requested.v1' },
          state: 'planning',
        },
      });
      const afterFixture = await f.db.outbox.count();
      await assert.rejects(
        f.db.executionResourceClaim.create({
          data: {
            id: randomUUID(),
            execution_id: execution.id,
            resource_key: resources[0].resource_key,
          },
        }),
        /reserved by an unsigned batch/,
      );
      await f.service.releaseUnsigned(row.batch_id);
      assert.equal(await f.db.withdrawalBatchResource.count({ where: { active: true } }), 0);
      assert.equal(await f.db.withdrawalBatchPreparation.count(), 1);
      await assert.rejects(f.service.prepareBitcoin(row.batch_id), /already released/);
      assert.equal(await f.db.outbox.count(), afterFixture);
      for (const member of f.manifest.members) {
        const w = await f.db.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
        assert.equal(w.reservation_id, member.reservationId);
        assert.equal(w.state, 'queued');
      }
      await f.db.executionResourceClaim.create({
        data: {
          id: randomUUID(),
          execution_id: execution.id,
          resource_key: resources[0].resource_key,
        },
      });
      const next = {
        ...f.manifest,
        batchId: randomUUID(),
        members: f.manifest.members.map((m) => ({ ...m, attemptId: randomUUID() })),
      };
      await f.service.claim(next);
      await assert.rejects(
        f.service.prepareBitcoin(next.batchId),
        /already retained by an individual attempt/,
      );
      assert.equal(
        await f.db.withdrawalBatchPreparation.count({ where: { batch_id: next.batchId } }),
        0,
      );
      assert.equal(await f.db.withdrawalBatchResource.count({ where: { active: true } }), 0);
      await f.service.releaseUnsigned(next.batchId);
    } finally {
      await f.close();
    }
  },
);

async function fixture(chain: 'bitcoin' | 'solana' = 'bitcoin') {
  const isolated = await isolatedDatabase(databaseUrl!);
  const db = new WalletPrismaService({ databaseUrl: isolated.url });
  try {
    const domainId = 'batch-' + randomUUID(),
      config = custodySettings(domainId),
      auth = new MessageAuth('q'.repeat(64), randomUUID());
    const custody = new CustodyService(
      db,
      config,
      { domainId, apiKey: 'c'.repeat(64) },
      auth,
      acceptanceRollout,
    );
    const bootstrap = await custody.bootstrap(),
      hot = bootstrap.hotWallets.find((w) => w.chain === chain)!;
    const core = await SigningCore.create(
      testMnemonic,
      config.seedId,
      config.ethereumChainId,
      undefined,
      { domainId, chainNetworks: config.chainNetworks ?? {} },
    );
    let address: string, destination: string;
    try {
      address = core.derive({ seedId: config.seedId, chain, account: 0 }).address;
      destination = core.derive({ seedId: config.seedId, chain, account: 20 }).address;
    } finally {
      core.close();
    }
    await db.wallet.update({
      where: { id: hot.id },
      data: { address, status: 'ready', registry_revision: 1, published_at: new Date() },
    });
    await db.exchangeWalletRegistry.create({
      data: {
        wallet_id: hot.id,
        domain_id: domainId,
        reset_epoch: auth.resetEpoch,
        chain,
        network: hot.network,
        address,
        role: 'hot',
        account: 0,
        registry_revision: 1,
        ledger_status: 'ready',
        ledger_ack_revision: 1,
        request: {},
      },
    });
    const asset = { chain, network: hot.network, assetId: `token:${chain}:native` };
    await db.assetConfiguration.update({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: domainId,
          chain,
          network: hot.network,
          asset_id: asset.assetId,
        },
      },
      data: { withdrawal_enabled: true },
    });
    const members = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID(),
        customerId = randomUUID(),
        reservationId = randomUUID();
      const requestDigest = 'a'.repeat(64);
      await db.exchangeCustomer.create({
        data: {
          customer_id: customerId,
          external_id: customerId,
          domain_id: domainId,
          reset_epoch: auth.resetEpoch,
          ledger_status: 'ready',
        },
      });
      // Mirrored accepted hold fixture; planning must not alter or release any Ledger hold.
      await db.withdrawal.create({
        data: {
          id,
          customer_id: customerId,
          domain_id: domainId,
          reset_epoch: auth.resetEpoch,
          idempotency_key: id,
          request_digest: requestDigest,
          request: { fixture: 'accepted-reservation' },
          chain,
          network: hot.network,
          asset_id: asset.assetId,
          destination,
          principal_units: '1000',
          policy_version: 'exchange-financial-v1',
          hot_wallet_id: hot.id,
          hot_registry_revision: 1,
          reservation_id: reservationId,
          state: 'queued',
        },
      });
      members.push({
        operationId: id,
        attemptId: randomUUID(),
        reservationId,
        customerId,
        requestDigest,
        destination,
        principalUnits: '1000',
        maximumFeeUnits: '1000',
        maximumRentUnits: '0',
      });
    }
    members.sort((a, b) => a.operationId.localeCompare(b.operationId));
    const manifest = payoutBatchManifestSchema.parse({
      version: 1,
      batchId: randomUUID(),
      domainId,
      resetEpoch: auth.resetEpoch,
      seedId: config.seedId,
      sourceWalletId: hot.id,
      sourceRegistryRevision: 1,
      sourceAddress: address,
      asset,
      members,
      feeAllocation: 'equal-largest-remainder-v1',
    });
    const rpc = new (class extends ChainRpcService {
      override async call(_chain: Chain, method: string, _params: unknown[]): Promise<unknown> {
        if (method === 'getblockchaininfo') return { chain: 'regtest' };
        if (method === 'listunspent')
          return [{ txid: 'a'.repeat(64), vout: 0, address, confirmations: 6 }];
        if (method === 'gettxout')
          return {
            value: '0.001',
            confirmations: 6,
            coinbase: false,
            scriptPubKey: {
              address,
              hex: '0014' + Buffer.from(regtestWitnessAddress(address).program).toString('hex'),
            },
          };
        if (method === 'estimatesmartfee') return { feerate: '0.00002' };
        throw new Error(`Unexpected batch fixture RPC ${method}`);
      }
    })({
      ethereumChainId: '11155111',
      solanaGenesisHash: 'unused',
      chainNetworks: config.chainNetworks,
    });
    const planner = new BitcoinBatchPlanner(rpc);
    const service = new BatchDraftsService(db, config, auth, planner);
    return {
      db,
      manifest,
      service,
      hot,
      planner,
      custody,
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
  'batch draft owns every original withdrawal atomically, deduplicates identical plans and dissolves without releasing customer holds',
  { skip: !databaseUrl },
  async () => {
    const f = await fixture();
    try {
      const before = await f.db.outbox.count();
      const draft = await f.service.claim(f.manifest);
      assert.equal((await f.service.claim(structuredClone(f.manifest))).id, draft.id);
      assert.equal(
        await f.db.withdrawalBatchDraftMember.count({
          where: { batch_id: draft.id, active: true },
        }),
        3,
      );
      for (const member of f.manifest.members) {
        const w = await f.db.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
        assert.equal(w.batch_draft_id, draft.id);
        assert.equal(w.attempt_id, member.attemptId);
        assert.equal(w.reservation_id, member.reservationId);
        assert.equal(w.state, 'batch_planned');
      }
      await assert.rejects(
        () =>
          f.service.claim({
            ...f.manifest,
            members: f.manifest.members.map((m, i) =>
              i === 0 ? { ...m, principalUnits: '1001' } : m,
            ),
          }),
        /immutable/,
      );
      await assert.rejects(
        () =>
          f.db.withdrawal.update({
            where: { id: f.manifest.members[0].operationId },
            data: { cancel_requested: true },
          }),
        /original withdrawal terms|immutable/,
      );
      await assert.rejects(
        () =>
          f.db.withdrawalBatchDraftMember.delete({
            where: { batch_id_member_index: { batch_id: draft.id, member_index: 0 } },
          }),
        /retained/,
      );
      await assert.rejects(
        () =>
          f.db.transaction.create({
            data: {
              id: randomUUID(),
              wallet_id: f.hot.id,
              idempotency_key: randomUUID(),
              request_hash: 'a'.repeat(64),
              intent: {},
              status: 'preparing',
            },
          }),
        /retained unsigned batch/,
      );
      await assert.rejects(
        () =>
          f.db.withdrawalBatchDraft.update({
            where: { id: draft.id },
            data: { state: 'released', released_at: new Date() },
          }),
        /dissolve every member/,
      );
      await f.service.releaseUnsigned(draft.id);
      await f.service.releaseUnsigned(draft.id);
      for (const member of f.manifest.members) {
        const w = await f.db.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
        assert.equal(w.batch_draft_id, null);
        assert.equal(w.attempt_id, null);
        assert.equal(w.reservation_id, member.reservationId);
        assert.equal(w.state, 'queued');
      }
      assert.equal(
        await f.db.outbox.count(),
        before,
        'Draft ownership cannot enqueue signing, broadcast or a financial release',
      );
      assert.equal(
        await f.db.withdrawalBatchDraftMember.count({ where: { batch_id: draft.id } }),
        3,
        'Released membership history is retained',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'incomplete draft and changed original member terms roll back without taking the source or any hold',
  { skip: !databaseUrl },
  async () => {
    const f = await fixture('solana');
    try {
      const changed = {
        ...f.manifest,
        members: f.manifest.members.map((m, i) => (i === 2 ? { ...m, principalUnits: '1001' } : m)),
      };
      await assert.rejects(() => f.service.claim(changed), /original held withdrawal/);
      assert.equal(await f.db.withdrawalBatchDraft.count(), 0);
      assert.equal(await f.db.withdrawal.count({ where: { batch_draft_id: { not: null } } }), 0);
      await assert.rejects(
        () =>
          f.db.withdrawalBatchDraft.create({
            data: {
              id: f.manifest.batchId,
              source_wallet_id: f.hot.id,
              domain_id: f.manifest.domainId,
              reset_epoch: f.manifest.resetEpoch,
              manifest: f.manifest,
              manifest_digest: payoutBatchDigest(f.manifest),
            },
          }),
        /complete immutable membership/,
      );
      assert.equal(await f.db.withdrawalBatchDraft.count(), 0);
      await f.service.claim(f.manifest);
    } finally {
      await f.close();
    }
  },
);

test(
  'competing batch claims serialize ownership of the source and preserve exact original member bindings',
  { skip: !databaseUrl },
  async () => {
    const f = await fixture();
    try {
      const other = {
        ...f.manifest,
        batchId: randomUUID(),
        members: f.manifest.members.map((m) => ({ ...m, attemptId: randomUUID() })),
      };
      const results = await Promise.allSettled([
        f.service.claim(f.manifest),
        f.service.claim(other),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(await f.db.withdrawalBatchDraft.count({ where: { state: 'planned' } }), 1);
      assert.equal(await f.db.withdrawalBatchDraftMember.count({ where: { active: true } }), 3);
    } finally {
      await f.close();
    }
  },
);
