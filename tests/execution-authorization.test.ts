import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  executionDigest,
  executionRequestDigest,
  ExecutionAuthorizationClaims,
  signExecutionAuthorization,
  signSignerAttestation,
  verifyExecutionAuthorization,
  verifySignerAttestation,
} from '../packages/shared/src/execution-authorization.js';
import { SignRequest } from '../packages/shared/src/contracts.js';

const authority = generateKeyPairSync('ed25519'),
  signer = generateKeyPairSync('ed25519');
const request: SignRequest = {
  wallet: {
    chain: 'ethereum',
    network: '11155111',
    seedId: 'test',
    account: 10,
    address: '0x' + '01'.repeat(20),
  },
  transaction: {
    chain: 'ethereum',
    chainId: '11155111',
    nonce: '0',
    to: '0x' + '02'.repeat(20),
    amount: '10000000000000000',
    gasLimit: '21000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  },
};

function claims(): ExecutionAuthorizationClaims {
  const requestHash = executionRequestDigest(request);
  return {
    version: 1,
    purpose: 'native_sweep',
    domainId: 'exchange',
    resetEpoch: 'epoch',
    seedId: 'test',
    customerId: randomUUID(),
    source: {
      walletId: randomUUID(),
      role: 'customer_deposit',
      account: 10,
      path: "m/44'/60'/10'/0/0",
      address: request.wallet.address,
      registryRevision: 1,
    },
    target: {
      walletId: randomUUID(),
      role: 'hot',
      account: 0,
      path: "m/44'/60'/0'/0/0",
      address: request.transaction.chain === 'ethereum' ? request.transaction.to : '',
      registryRevision: 1,
      domainId: 'exchange',
      seedId: 'test',
    },
    asset: { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' },
    policyVersion: 'exchange-financial-v1',
    operationId: randomUUID(),
    attemptId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    preparationDigest: requestHash,
    requestHash,
    principalUnits: '10000000000000000',
    maxFeeUnits: '42000000000000',
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
}

test('canonical execution digests preserve field values and ignore object insertion order', () => {
  assert.equal(
    executionDigest({ b: [1, '2'], a: true }),
    executionDigest({ a: true, b: [1, '2'] }),
  );
  assert.notEqual(executionDigest({ a: '1' }), executionDigest({ a: 1 }));
  assert.throws(() => executionDigest({ a: undefined }));
  assert.throws(() => executionDigest({ a: Number.MAX_SAFE_INTEGER + 1 }));
});

test('authorization uses a separate Ed25519 authority and rejects every changed signed field', () => {
  const original = claims(),
    signed = signExecutionAuthorization(original, authority.privateKey);
  assert.deepEqual(verifyExecutionAuthorization(signed, authority.publicKey), original);
  assert.throws(() => verifyExecutionAuthorization(signed, signer.publicKey));
  for (const change of [
    { resetEpoch: 'old' },
    { domainId: 'other' },
    { principalUnits: '10000000000000001' },
    { attemptId: randomUUID() },
    { requestHash: 'b'.repeat(64) },
    { expiresAt: new Date().toISOString() },
    { source: { ...original.source, registryRevision: 2 } },
    { target: { ...original.target, address: '0x' + '03'.repeat(20) } },
  ]) {
    assert.throws(() =>
      verifyExecutionAuthorization(
        { ...signed, claims: { ...original, ...change } },
        authority.publicKey,
      ),
    );
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signExecutionAuthorization(original, rsa.privateKey), /Ed25519/);
});

test('signer attestation binds the entire result and cannot be forged using the authority key', () => {
  const result = {
    type: 'transaction.custody.rejected',
    transactionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    preparationDigest: 'b'.repeat(64),
    reason: 'Policy rejected',
  };
  const attestation = signSignerAttestation(
    {
      version: 1,
      domainId: 'exchange',
      resetEpoch: 'epoch',
      transactionId: result.transactionId,
      operationId: result.operationId,
      attemptId: result.attemptId,
      requestDigest: result.requestDigest,
      preparationDigest: result.preparationDigest,
      status: 'rejected',
      resultDigest: executionDigest(result),
    },
    signer.privateKey,
  );
  assert.equal(verifySignerAttestation(attestation, result, signer.publicKey).status, 'rejected');
  assert.throws(
    () => verifySignerAttestation(attestation, { ...result, reason: 'Approved' }, signer.publicKey),
    /mismatch/,
  );
  assert.throws(
    () =>
      verifySignerAttestation(
        attestation,
        { ...result, transactionId: randomUUID() },
        signer.publicKey,
      ),
    /mismatch/,
  );
  assert.throws(
    () => verifySignerAttestation(attestation, result, authority.publicKey),
    /signature/,
  );
});
