import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  verify as verifyEd25519,
} from 'node:crypto';
import { Transaction as EthTransaction } from 'ethers';
import { verify as verifySecp } from '@bitcoinerlab/secp256k1';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import {
  executionDigest,
  executionRequestDigest,
  ExecutionAuthorizationClaims,
  signExecutionAuthorization,
  verifySignerAttestation,
} from '../packages/shared/src/execution-authorization.js';
import {
  CustodySignAction,
  custodySignSchema,
} from '../packages/shared/src/execution-contracts.js';
import { SignRequest } from '../packages/shared/src/contracts.js';
const bitcoinPromise = import('bitcoinjs-lib');
let bitcoin: Awaited<typeof bitcoinPromise>;
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const networks = {
  ethereum: { network: '11155111', chainId: '11155111' },
  bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
  solana: {
    network: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  },
};
const authority = generateKeyPairSync('ed25519'),
  attestor = generateKeyPairSync('ed25519');
let core: SigningCore, service: SigningService, policy: CustodySigningPolicy;
before(async () => {
  bitcoin = await bitcoinPromise;
  core = await SigningCore.create(mnemonic, 'test', '11155111', undefined, {
    domainId: 'exchange',
    chainNetworks: networks,
  });
  policy = new CustodySigningPolicy(
    {
      enabled: true,
      domainId: 'exchange',
      resetEpoch: 'epoch',
      authorityPublicKey: authority.publicKey,
      attestationPrivateKey: attestor.privateKey,
    },
    core,
  );
  service = new SigningService(core, policy);
});
after(() => core.close());

function action(chain: 'ethereum' | 'bitcoin' | 'solana'): CustodySignAction {
  const source = core.derive({ chain, seedId: 'test', account: 10 }),
    target = core.derive({ chain, seedId: 'test', account: 0 });
  const wallet = {
    chain,
    seedId: 'test',
    account: 10,
    address: source.address,
    network: networks[chain].network,
  };
  const principalUnits = { ethereum: '10000000000000000', bitcoin: '199700', solana: '1000000' }[
      chain
    ],
    maxFeeUnits = { ethereum: '42000000000000', bitcoin: '300', solana: '5000' }[chain];
  let request: SignRequest;
  if (chain === 'ethereum')
    request = {
      wallet,
      transaction: {
        chain,
        chainId: '11155111',
        nonce: '7',
        to: target.address,
        amount: principalUnits,
        gasLimit: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '1000000000',
      },
    };
  else if (chain === 'bitcoin')
    request = {
      wallet,
      transaction: {
        chain,
        outputs: [{ address: target.address, amount: principalUnits }],
        utxos: [
          {
            txid: '01'.repeat(32),
            vout: 1,
            amount: '200000',
            script: Buffer.from(
              bitcoin.address.toOutputScript(source.address, bitcoin.networks.regtest),
            ).toString('hex'),
          },
        ],
        satsPerVbyte: 2,
        sweepAll: true,
      },
    };
  else
    request = {
      wallet,
      transaction: {
        chain,
        outputs: [{ address: target.address, amount: principalUnits }],
        recentBlockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 100,
      },
    };
  const preparationDigest = executionRequestDigest(request),
    operationId = randomUUID(),
    attemptId = randomUUID(),
    requestDigest = executionDigest({ operationId, attemptId });
  const claims: ExecutionAuthorizationClaims = {
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
      path: source.path,
      address: source.address,
      registryRevision: 1,
    },
    target: {
      walletId: randomUUID(),
      role: 'hot',
      account: 0,
      path: target.path,
      address: target.address,
      registryRevision: 1,
      seedId: 'test',
      domainId: 'exchange',
    },
    asset: { chain, network: networks[chain].network, assetId: `token:${chain}:native` },
    policyVersion: 'exchange-financial-v1',
    operationId,
    attemptId,
    requestDigest,
    preparationDigest,
    requestHash: preparationDigest,
    principalUnits,
    maxFeeUnits,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  return custodySignSchema.parse({
    type: 'transaction.custody.sign',
    transactionId: randomUUID(),
    operationId,
    attemptId,
    requestDigest,
    preparationDigest,
    request,
    authorization: signExecutionAuthorization(claims, authority.privateKey),
  });
}

function sign(a: CustodySignAction) {
  const result = service.execute(a);
  assert.equal(result.type, 'transaction.custody.signed');
  if (result.type !== 'transaction.custody.signed') throw new Error('Unexpected signer result');
  const { signerAttestation, ...unsigned } = result;
  assert.equal(
    verifySignerAttestation(signerAttestation, unsigned, attestor.publicKey).status,
    'signed',
  );
  return result.signed;
}

test('authorized Ethereum native sweep independently decodes exact hot payout and signer', () => {
  const a = action('ethereum'),
    signed = sign(a),
    decoded = EthTransaction.from(signed.raw);
  assert.equal(decoded.from?.toLowerCase(), a.request.wallet.address.toLowerCase());
  assert.equal(decoded.to?.toLowerCase(), a.authorization.claims.target.address.toLowerCase());
  assert.equal(decoded.value, BigInt(a.authorization.claims.principalUnits));
  assert.equal(decoded.chainId, 11155111n);
  assert.equal(decoded.data, '0x');
  assert.equal(decoded.hash, signed.txHash);
});

test('authorized Bitcoin sweep spends every reserved input with one hot output and independently valid signature', () => {
  const a = action('bitcoin'),
    signed = sign(a),
    decoded = bitcoin.Transaction.fromHex(signed.raw);
  assert.equal(decoded.ins.length, 1);
  assert.equal(decoded.outs.length, 1);
  assert.equal(decoded.outs[0].value, 199700n);
  assert.equal(
    bitcoin.address.fromOutputScript(decoded.outs[0].script, bitcoin.networks.regtest),
    a.authorization.claims.target.address,
  );
  assert.equal(decoded.getId(), signed.txHash);
  const [sig, pubkey] = decoded.ins[0].witness,
    signature = bitcoin.script.signature.decode(sig);
  assert(
    verifySecp(
      decoded.hashForWitnessV0(
        0,
        bitcoin.payments.p2pkh({ pubkey }).output!,
        200000n,
        signature.hashType,
      ),
      pubkey,
      signature.signature,
    ),
  );
  assert(300n >= BigInt(decoded.virtualSize() * 2));
});

test('authorized Solana sweep verifies signature, fee payer, and sole system transfer', () => {
  const a = action('solana'),
    signed = sign(a),
    raw = Buffer.from(signed.raw, 'base64'),
    message = raw.subarray(65);
  assert.equal(raw[0], 1);
  const signerKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), message.subarray(4, 36)]),
    format: 'der',
    type: 'spki',
  });
  assert(verifyEd25519(null, message, signerKey, raw.subarray(1, 65)));
  assert.equal(message[3], 3);
  assert.equal(message[132], 1);
  assert.equal(message.readUInt32LE(message.length - 12), 2);
  assert.equal(message.readBigUInt64LE(message.length - 8), 1000000n);
});

test('shared queue integrity cannot bypass authority, request, epoch, destination, economics, or expiry policy', () => {
  const a = action('ethereum');
  for (const changed of [
    { requestDigest: 'b'.repeat(64) },
    { preparationDigest: 'c'.repeat(64) },
    { attemptId: randomUUID() },
    { request: { ...a.request, wallet: { ...a.request.wallet, account: 11 } } },
    { request: { ...a.request, transaction: { ...a.request.transaction, nonce: '8' } } },
  ]) {
    const result = service.execute(custodySignSchema.parse({ ...a, ...changed }));
    assert.equal(result.type, 'transaction.custody.rejected');
    if (result.type !== 'transaction.custody.rejected') throw new Error('Unexpected signer result');
    const { signerAttestation, ...unsigned } = result;
    assert.equal(
      verifySignerAttestation(signerAttestation, unsigned, attestor.publicKey).status,
      'rejected',
    );
  }
  for (const changed of [
    { domainId: 'other' },
    { resetEpoch: 'old' },
    { seedId: 'other' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { expiresAt: new Date(Date.now() + 600000).toISOString() },
    { maxFeeUnits: '100000000000000000' },
    { principalUnits: '1000000000000000' },
    { source: { ...a.authorization.claims.source, path: "m/44'/60'/11'/0/0" } },
    {
      target: {
        ...a.authorization.claims.target,
        address: core.derive({ chain: 'ethereum', seedId: 'test', account: 1 }).address,
      },
    },
  ]) {
    const claims = { ...a.authorization.claims, ...changed };
    const altered = custodySignSchema.parse({
      ...a,
      authorization: signExecutionAuthorization(claims, authority.privateKey),
    });
    assert.equal(service.execute(altered).type, 'transaction.custody.rejected');
  }
  const fake = generateKeyPairSync('ed25519');
  assert.equal(
    service.execute({
      ...a,
      authorization: signExecutionAuthorization(a.authorization.claims, fake.privateKey),
    }).type,
    'transaction.custody.rejected',
  );
  assert.throws(
    () =>
      service.execute({
        type: 'transaction.sign',
        transactionId: randomUUID(),
        request: a.request,
      }),
    /Legacy signing is disabled/,
  );
});

test('policy rejects source role changes, extra BTC/Solana outputs, altered fee caps, and disabled execution', () => {
  const a = action('bitcoin');
  assert.throws(() =>
    custodySignSchema.parse({
      ...a,
      authorization: {
        ...a.authorization,
        claims: {
          ...a.authorization.claims,
          source: { ...a.authorization.claims.source, role: 'hot', account: 0 },
        },
      },
    }),
  );
  for (const chain of ['bitcoin', 'solana'] as const) {
    const command = action(chain);
    const tx = command.request.transaction;
    if (!('outputs' in tx)) throw new Error('Unexpected transaction');
    const request = {
      ...command.request,
      transaction: {
        ...tx,
        outputs: [...tx.outputs, { address: command.request.wallet.address, amount: '1' }],
      },
    };
    const hash = executionRequestDigest(request);
    const altered = custodySignSchema.parse({
      ...command,
      request,
      preparationDigest: hash,
      authorization: signExecutionAuthorization(
        { ...command.authorization.claims, requestHash: hash, preparationDigest: hash },
        authority.privateKey,
      ),
    });
    assert.equal(service.execute(altered).type, 'transaction.custody.rejected');
  }
  const disabled = new SigningService(
    core,
    new CustodySigningPolicy({ enabled: false, domainId: 'exchange', resetEpoch: 'epoch' }, core),
  );
  assert.throws(() => disabled.execute(a), /disabled/);
});

test('custody signer refuses a shared authority/attestation identity and incorrect key ownership', () => {
  assert.throws(
    () =>
      new CustodySigningPolicy(
        {
          enabled: true,
          domainId: 'exchange',
          resetEpoch: 'epoch',
          authorityPublicKey: authority.publicKey,
          attestationPrivateKey: authority.privateKey,
        },
        core,
      ),
    /separate/,
  );
  assert.throws(
    () =>
      new CustodySigningPolicy(
        {
          enabled: true,
          domainId: 'exchange',
          resetEpoch: 'epoch',
          authorityPublicKey: authority.privateKey,
          attestationPrivateKey: attestor.privateKey,
        },
        core,
      ),
    /ownership/,
  );
});
