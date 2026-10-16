import { batchWalletFixture as fixture } from './helpers/batch-wallet-fixture.js';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { payoutBatchDigest } from '../packages/shared/src/payout-policy.js';
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
