import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  allocateBatchCosts,
  payoutBatchDigest,
  payoutBatchManifestSchema,
  mapBatchOutputs,
  planEvmWindow,
  EvmWindowSnapshot,
  EvmWindowAllocation,
} from '../packages/shared/src/payout-policy.js';

function batch() {
  return payoutBatchManifestSchema.parse({
    version: 1,
    batchId: randomUUID(),
    domainId: 'exchange',
    resetEpoch: 'epoch',
    seedId: 'seed',
    sourceWalletId: randomUUID(),
    sourceRegistryRevision: 1,
    sourceAddress: 'bcrt1q' + 'a'.repeat(38),
    asset: { chain: 'bitcoin', network: 'regtest', assetId: 'token:bitcoin:native' },
    feeAllocation: 'equal-largest-remainder-v1',
    members: Array.from({ length: 3 }, () => ({
      operationId: randomUUID(),
      attemptId: randomUUID(),
      reservationId: randomUUID(),
      customerId: randomUUID(),
      requestDigest: 'a'.repeat(64),
      destination: 'bcrt1q' + 'b'.repeat(38),
      principalUnits: '1000',
      maximumFeeUnits: '1000',
      maximumRentUnits: '0',
    })).sort((a, b) => a.operationId.localeCompare(b.operationId)),
  });
}

test('batch members retain separate obligations even when recipients are identical; costs conserve exact integer totals', () => {
  const manifest = batch();
  assert.deepEqual(
    allocateBatchCosts(manifest, '5').map((m) => m.feeUnits),
    ['2', '2', '1'],
  );
  for (let fee = 0n; fee < 200n; fee++) {
    const shares = allocateBatchCosts(manifest, fee.toString());
    assert.equal(
      shares.reduce((sum, m) => sum + BigInt(m.feeUnits), 0n),
      fee,
    );
    assert.deepEqual(
      shares.map((m) => m.memberIndex),
      [0, 1, 2],
    );
    assert.equal(new Set(shares.map((m) => m.reservationId)).size, 3);
  }
  assert.equal(payoutBatchDigest(manifest), payoutBatchDigest(structuredClone(manifest)));
  assert.notEqual(
    payoutBatchDigest(manifest),
    payoutBatchDigest({
      ...manifest,
      members: manifest.members.map((m, i) => (i === 0 ? { ...m, principalUnits: '1001' } : m)),
    }),
  );
});

test('batch contract rejects duplicate obligations, changed ordering, EVM batching, unapproved rent and exceeded member fee budgets', () => {
  const manifest = batch();
  for (const key of ['operationId', 'attemptId', 'reservationId'] as const) {
    const changed = structuredClone(manifest);
    changed.members[1][key] = changed.members[0][key];
    assert.throws(() => payoutBatchManifestSchema.parse(changed));
  }
  assert.throws(() =>
    payoutBatchManifestSchema.parse({ ...manifest, members: [...manifest.members].reverse() }),
  );
  assert.throws(() =>
    payoutBatchManifestSchema.parse({
      ...manifest,
      asset: { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' },
    }),
  );
  const withRent = structuredClone(manifest);
  withRent.members[0].maximumRentUnits = '1';
  assert.throws(() => payoutBatchManifestSchema.parse(withRent));
  assert.throws(() => allocateBatchCosts(manifest, '3001'), /budget/);
  assert.throws(
    () => allocateBatchCosts(manifest, '1', new Map([[randomUUID(), '1']])),
    /nonmember/,
  );
  assert.throws(
    () => allocateBatchCosts(manifest, '1', new Map([[manifest.members[0].operationId, '1']])),
    /budget/,
  );
});

const token = 'token:ethereum:erc20:0x' + 'a'.repeat(40);

function snapshot(): EvmWindowSnapshot {
  return {
    latestNonce: '0',
    pendingNonce: '0',
    nativeFinalizedUnits: '1000',
    nativePendingUnits: '1000',
    tokenBalances: new Map([[token, { finalizedUnits: '1000', pendingUnits: '1000' }]]),
  };
}

function proposal(assetId = 'token:ethereum:native') {
  return { attemptId: randomUUID(), assetId, principalUnits: '100', maximumFeeUnits: '10' };
}

test('EVM window reserves native principal and token gas together and bounds slots independently of customer balances', () => {
  const observed = snapshot();
  const a = planEvmWindow(observed, [], proposal(), 3);
  const b = planEvmWindow(observed, [a], proposal(token), 3);
  const c = planEvmWindow(observed, [a, b], proposal(), 3);
  assert.deepEqual([a.nonce, b.nonce, c.nonce], ['0', '1', '2']);
  assert.throws(() => planEvmWindow(observed, [a, b, c], proposal(), 3), /full/);
  observed.nativeFinalizedUnits = '119';
  assert.throws(() => planEvmWindow(observed, [a], proposal(token), 3), /native/);
  observed.nativeFinalizedUnits = '120';
  assert.equal(planEvmWindow(observed, [a], proposal(token), 3).nonce, '1');
  const scarce = {
    ...observed,
    tokenBalances: new Map([[token, { finalizedUnits: '99', pendingUnits: '1000' }]]),
  };
  assert.throws(() => planEvmWindow(scarce, [a], proposal(token), 3), /token/);
});

test('EVM window retains uncertain and reverted exposure; unknown nonce advances, unsigned occupied slots and duplicate identities stop admission', () => {
  const observed = snapshot(),
    a = planEvmWindow(observed, [], proposal(), 3);
  assert.throws(
    () => planEvmWindow({ ...observed, pendingNonce: '1' }, [a], proposal(), 3),
    /Untracked/,
  );
  const submitted: EvmWindowAllocation = { ...a, state: 'submitted' };
  assert.equal(
    planEvmWindow({ ...observed, pendingNonce: '1' }, [submitted], proposal(), 3).nonce,
    '1',
  );
  assert.throws(
    () => planEvmWindow({ ...observed, pendingNonce: '2' }, [submitted], proposal(), 3),
    /Untracked/,
  );
  assert.throws(
    () =>
      planEvmWindow(
        { ...observed, latestNonce: '1', pendingNonce: '1' },
        [submitted],
        proposal(),
        3,
      ),
    /reconciliation/,
  );
  for (const state of ['uncertain', 'reverted'] as const)
    assert.throws(
      () =>
        planEvmWindow(
          { ...observed, nativePendingUnits: '219' },
          [{ ...a, state }],
          { ...proposal(), principalUnits: '110' },
          3,
        ),
      /native/,
    );
  assert.throws(
    () => planEvmWindow(observed, [a, { ...a, attemptId: randomUUID() }], proposal(), 3),
    /collision/,
  );
  assert.throws(() => planEvmWindow(observed, [], proposal(), 17), /limit/);
  // A released unsigned gap can be filled; it must not advance the next nonce past that gap.
  assert.equal(planEvmWindow(observed, [{ ...a, nonce: '1' }], proposal(), 3).nonce, '0');
});

test('Bitcoin output mapping accounts for Wallet Core change before extra outputs', () => {
  const manifest = batch();
  assert.deepEqual(
    mapBatchOutputs(manifest, '1000').map((m) => m.outputIndex),
    [0, 2, 3],
  );
  assert.deepEqual(
    mapBatchOutputs(manifest).map((m) => m.outputIndex),
    [0, 1, 2],
  );
  assert.throws(() => mapBatchOutputs(manifest, '545'), /dust/);
});
