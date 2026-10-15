import 'reflect-metadata';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import { bitcoinBatchFixture } from './helpers/bitcoin-batch-fixture.js';
import { testMnemonic } from './helpers/custody-fixture.js';
import {
  BitcoinBatchSignAction,
  signBitcoinBatchAuthorization,
  bitcoinBatchAttestedResult,
  validateBitcoinBatch,
} from '../packages/shared/src/bitcoin-batch-contracts.js';
import {
  executionDigest,
  verifySignerAttestation,
} from '../packages/shared/src/execution-authorization.js';
import { verifyBitcoinPayment } from '../packages/chain/src/native-sweep-planner.js';

const authority = generateKeyPairSync('ed25519'),
  attestor = generateKeyPairSync('ed25519');
let core: SigningCore, service: SigningService;
before(async () => {
  core = await SigningCore.create(testMnemonic, 'batch-signing', '11155111', undefined, {
    domainId: 'exchange',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  });
  service = new SigningService(
    core,
    new CustodySigningPolicy(
      {
        enabled: true,
        withdrawalsEnabled: true,
        bitcoinBatchesEnabled: true,
        domainId: 'exchange',
        resetEpoch: 'epoch',
        authorityPublicKey: authority.publicKey,
        attestationPrivateKey: attestor.privateKey,
      },
      core,
    ),
  );
});
after(() => core.close());

async function action(): Promise<BitcoinBatchSignAction> {
  const f = await bitcoinBatchFixture(core, 'exchange', 'epoch');
  return {
    type: 'payout.batch.sign',
    batchId: f.manifest.batchId,
    transactionId: randomUUID(),
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
        transactionId: randomUUID(),
        manifestDigest: f.preparation.manifestDigest,
        preparationDigest: f.preparation.preparationDigest,
        sourcePath: f.source.path,
        expiresAt: f.preparation.expiresAt,
      },
      authority.privateKey,
    ),
  };
}

function authorize(a: BitcoinBatchSignAction) {
  a.authorization.claims.transactionId = a.transactionId;
  a.authorization = signBitcoinBatchAuthorization(a.authorization.claims, authority.privateKey);
  return a;
}

test('independent Bitcoin batch signing binds every original member and exact bytes, with a verifiable separate-key attestation', async () => {
  const a = authorize(await action()),
    result = service.execute(a);
  assert.equal(result.type, 'payout.batch.signed');
  if (result.type !== 'payout.batch.signed') throw new Error('Expected signed batch');
  const { signerAttestation, ...unsigned } = result;
  const claims = verifySignerAttestation(
    signerAttestation,
    bitcoinBatchAttestedResult(unsigned),
    attestor.publicKey,
  );
  assert.equal(claims.status, 'signed');
  assert.equal(claims.requestDigest, a.preparation.manifestDigest);
  assert.equal(
    verifyBitcoinPayment(a.preparation.request, result.signed).feeUnits,
    a.preparation.feeUnits,
  );
  const changed = structuredClone(result);
  changed.signed.txHash = 'f'.repeat(64);
  assert.throws(() =>
    verifySignerAttestation(
      changed.signerAttestation,
      bitcoinBatchAttestedResult(changed),
      attestor.publicKey,
    ),
  );
});

test('Bitcoin batch signing rejects changed recipient, input, budget, scope, derivation, signature and expired authority', async () => {
  const mutations: ((a: BitcoinBatchSignAction) => void)[] = [
    (a) => {
      a.manifest.members[0].principalUnits = '1001';
    },
    (a) => {
      a.preparation.memberOutputs.reverse();
    },
    (a) => {
      if (a.preparation.request.transaction.chain === 'bitcoin')
        a.preparation.request.transaction.utxos[0].script = '0014' + 'f'.repeat(40);
    },
    (a) => {
      a.authorization.claims.resetEpoch = 'stale';
      authorize(a);
    },
    (a) => {
      a.authorization.claims.sourcePath = core.derive({
        chain: 'bitcoin',
        seedId: core.seedId,
        account: 10,
      }).path;
      authorize(a);
    },
    (a) => {
      a.authorization.claims.expiresAt = new Date(Date.now() - 1).toISOString();
      authorize(a);
    },
    (a) => {
      a.transactionId = randomUUID();
    },
    (a) => {
      a.authorization = signBitcoinBatchAuthorization(
        a.authorization.claims,
        generateKeyPairSync('ed25519').privateKey,
      );
    },
  ];
  for (const mutate of mutations) {
    const a = authorize(await action());
    mutate(a);
    const result = service.execute(a);
    assert.equal(result.type, 'payout.batch.rejected');
    if (result.type !== 'payout.batch.rejected') throw new Error('Expected rejected batch');
    assert.equal(
      verifySignerAttestation(
        result.signerAttestation,
        bitcoinBatchAttestedResult(result),
        attestor.publicKey,
      ).status,
      'rejected',
    );
  }
  const a = authorize(await action());
  a.preparation.memberCosts[0].feeUnits = '0';
  const { preparationDigest: _digest, ...body } = a.preparation;
  a.preparation.preparationDigest = executionDigest(body);
  assert.throws(() => validateBitcoinBatch(a.manifest, a.preparation), /conservation mismatch/);
});

test('single-withdrawal enablement alone cannot enable Bitcoin batch signing', async () => {
  const closed = new SigningService(
    core,
    new CustodySigningPolicy(
      {
        enabled: true,
        withdrawalsEnabled: true,
        domainId: 'exchange',
        resetEpoch: 'epoch',
        authorityPublicKey: authority.publicKey,
        attestationPrivateKey: attestor.privateKey,
      },
      core,
    ),
  );
  await assert.rejects(
    async () => closed.execute(authorize(await action())),
    /batch signing is disabled/,
  );
});
