import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignRequest } from '../packages/shared/src/contracts.js';
import { TokenSignRequest } from '../packages/shared/src/token-contracts.js';
import {
  withdrawalReplacementConflict,
  withdrawalReplacementLineage,
} from '../packages/shared/src/replacement-policy.js';

function eth(): SignRequest {
  return {
    wallet: {
      chain: 'ethereum',
      network: '11155111',
      seedId: 'seed',
      account: 0,
      address: '0x' + 'ab'.repeat(20),
    },
    transaction: {
      chain: 'ethereum',
      chainId: '11155111',
      nonce: '7',
      to: '0x' + 'cd'.repeat(20),
      amount: '100',
      gasLimit: '21000',
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '8',
    },
  };
}

function bumped(r: SignRequest): SignRequest {
  if (!('nonce' in r.transaction)) throw new Error('fixture');
  return {
    ...r,
    transaction: { ...r.transaction, maxFeePerGas: '125', maxPriorityFeePerGas: '10' },
  };
}

test('EVM replacement retains exact original principal, recipient, source and nonce while bounding fee growth', () => {
  const original = eth(),
    next = bumped(original);
  const proof = withdrawalReplacementConflict(original, next);
  assert.equal(proof.kind, 'evm_same_nonce');
  assert.equal(proof.maximumFeeUnits, '2625000');
  assert.deepEqual(proof.resourceKeys, ['nonce:' + original.wallet.address.toLowerCase() + ':7']);
  for (const change of [
    { nonce: '8' },
    { amount: '101' },
    { to: '0x' + 'ef'.repeat(20) },
    { gasLimit: '22000' },
    { maxFeePerGas: '112' },
    { maxPriorityFeePerGas: '8' },
  ]) {
    assert.throws(
      () =>
        withdrawalReplacementConflict(original, {
          ...next,
          transaction: { ...next.transaction, ...change },
        } as SignRequest),
      /rejected/,
    );
  }
  assert.throws(
    () =>
      withdrawalReplacementConflict(original, { ...next, wallet: { ...next.wallet, account: 1 } }),
    /hot source/,
  );
  assert.throws(
    () =>
      withdrawalReplacementConflict(original, {
        ...next,
        wallet: { ...next.wallet, seedId: 'other' },
      }),
    /hot source/,
  );
  assert.throws(
    () =>
      withdrawalReplacementConflict(original, {
        ...next,
        transaction: { ...next.transaction, maxFeePerGas: '100000000001' },
      } as SignRequest),
    /budget/,
  );
});

test('ERC-20 replacement is fixed transfer-only and cannot change contract, recipient or token amount', () => {
  const native = eth();
  if (!('nonce' in native.transaction)) throw new Error('fixture');
  const { to, ...tx } = native.transaction;
  const original: TokenSignRequest = {
    wallet: { ...native.wallet, chain: 'ethereum', network: '11155111' },
    transaction: {
      ...tx,
      chain: 'ethereum',
      kind: 'erc20',
      chainId: '11155111',
      contract: '0x' + 'ef'.repeat(20),
      recipient: to,
    },
  };
  const next: TokenSignRequest = {
    ...original,
    transaction: {
      ...original.transaction,
      ...{ maxFeePerGas: '125', maxPriorityFeePerGas: '10' },
    },
  };
  assert.equal(withdrawalReplacementConflict(original, next).kind, 'evm_same_nonce');
  for (const change of [
    { amount: '101' },
    { contract: '0x' + 'ac'.repeat(20) },
    { recipient: '0x' + 'ac'.repeat(20) },
  ])
    assert.throws(
      () =>
        withdrawalReplacementConflict(original, {
          ...next,
          transaction: { ...next.transaction, ...change },
        } as TokenSignRequest),
      /changed/,
    );
  assert.throws(() => withdrawalReplacementConflict(native, next), /type changed/);
});

function btc(): SignRequest {
  return {
    wallet: {
      chain: 'bitcoin',
      network: 'regtest',
      seedId: 'seed',
      account: 0,
      address: 'bcrt1q' + 'a'.repeat(38),
    },
    transaction: {
      chain: 'bitcoin',
      outputs: [{ address: 'bcrt1q' + 'b'.repeat(38), amount: '10000' }],
      utxos: [{ txid: 'a'.repeat(64), vout: 0, amount: '20000', script: '0014' + 'ab'.repeat(20) }],
      satsPerVbyte: 2,
      changeAmount: '9000',
    },
  };
}

test('Bitcoin replacement conflicts every original input and changes only rate and hot change, preserving duplicate-recipient outputs', () => {
  const original = btc();
  if (!('utxos' in original.transaction)) throw new Error('fixture');
  const next: SignRequest = {
    ...original,
    transaction: { ...original.transaction, satsPerVbyte: 4, changeAmount: '8000' },
  };
  assert.equal(withdrawalReplacementConflict(original, next).maximumFeeUnits, '2000');
  for (const change of [
    { changeAmount: '9100' },
    { satsPerVbyte: 2 },
    { changeAmount: '1' },
    { outputs: [{ address: 'bcrt1q' + 'b'.repeat(38), amount: '10001' }] },
    { utxos: [{ ...original.transaction.utxos[0], txid: 'b'.repeat(64) }] },
    { utxos: [{ ...original.transaction.utxos[0], amount: '20001' }] },
  ])
    assert.throws(
      () =>
        withdrawalReplacementConflict(original, {
          ...next,
          transaction: { ...next.transaction, ...change },
        } as SignRequest),
      /rejected/,
    );
});

test('every retained payable predecessor must conflict and be more cheaply bounded, not just the latest projection', () => {
  const root = eth(),
    middle = bumped(root);
  const next = {
    ...middle,
    transaction: { ...middle.transaction, maxFeePerGas: '150', maxPriorityFeePerGas: '12' },
  } as SignRequest;
  assert.equal(withdrawalReplacementLineage([root, middle], next).kind, 'evm_same_nonce');
  assert.throws(() => withdrawalReplacementLineage([middle], bumped(root)), /increase/);
  assert.throws(() => withdrawalReplacementLineage([], next), /lineage/);
  assert.throws(() => withdrawalReplacementLineage(Array(9).fill(root), next), /lineage/);
});

test('Solana fresh blockhash cannot be treated as a mutually exclusive replacement or timer-based retry', () => {
  const original: SignRequest = {
    wallet: {
      chain: 'solana',
      network: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      seedId: 'seed',
      account: 0,
      address: 'a'.repeat(32),
    },
    transaction: {
      chain: 'solana',
      recentBlockhash: 'a'.repeat(32),
      lastValidBlockHeight: 100,
      outputs: [{ address: 'b'.repeat(32), amount: '1000' }],
    },
  };
  assert.throws(
    () =>
      withdrawalReplacementConflict(original, {
        ...original,
        transaction: { ...original.transaction, recentBlockhash: 'c'.repeat(32) },
      } as SignRequest),
    /nonpayment proof/,
  );
});
