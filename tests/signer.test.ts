import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction as EthTransaction } from 'ethers';
const bitcoinPromise = import('bitcoinjs-lib');
let bitcoin: Awaited<typeof bitcoinPromise>;
import { verify } from '@bitcoinerlab/secp256k1';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { SigningCore } from '../apps/signer/src/core';
import { derivationPath, signSchema, transferSchema } from '../packages/shared/src/contracts';

// Public BIP39 test vector. Never use this phrase for funds.
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let core: SigningCore;
before(async () => {
  bitcoin = await bitcoinPromise;
  core = await SigningCore.create(mnemonic, 'test', '11155111');
});
after(() => core.close());
function wallet(chain: 'ethereum' | 'bitcoin' | 'solana') {
  const { path: _path, ...w } = core.derive({ chain, account: 0, seedId: 'test' });
  return w;
}
test('canonical BIP44/BIP84 and fully hardened Solana derivation', () => {
  assert.equal(wallet('ethereum').address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(wallet('bitcoin').address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(derivationPath('solana', 0), "m/44'/501'/0'/0'");
  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const)
    assert.notEqual(
      wallet(chain).address,
      core.derive({ chain, account: 1, seedId: 'test' }).address,
    );
  assert.throws(() => derivationPath('ethereum', -1));
  assert.throws(() => derivationPath('ethereum', 2147483648));
});
test('Ethereum EIP1559 bytes recover the expected signer and chain', () => {
  const w = wallet('ethereum');
  const signed = core.sign({
    wallet: w,
    transaction: {
      chain: 'ethereum',
      chainId: '11155111',
      nonce: '7',
      to: w.address,
      amount: '1000000000000001',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
    },
  });
  const parsed = EthTransaction.from(signed.raw);
  assert.equal(parsed.from, w.address);
  assert.equal(parsed.chainId, 11155111n);
  assert.equal(parsed.nonce, 7);
  assert.equal(parsed.value, 1000000000000001n);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.hash, signed.txHash);
});
test('Bitcoin batch includes both recipients and correct change, with a valid SegWit signature', () => {
  const w = wallet('bitcoin');
  const recipient = core.derive({ chain: 'bitcoin', account: 1, seedId: 'test' }).address;
  const ownScript = Buffer.from(bitcoin.address.toOutputScript(w.address)).toString('hex');
  const txid = '01'.repeat(32);
  const signed = core.sign({
    wallet: w,
    transaction: {
      chain: 'bitcoin',
      outputs: [
        { address: recipient, amount: '10000' },
        { address: w.address, amount: '20000' },
      ],
      utxos: [{ txid, vout: 0, amount: '100000', script: ownScript }],
      satsPerVbyte: 2,
    },
  });
  const parsed = bitcoin.Transaction.fromHex(signed.raw);
  assert.equal(parsed.getId(), signed.txHash);
  assert.equal(parsed.ins.length, 1);
  assert.equal(parsed.outs.length, 3);
  assert.equal(Buffer.from(parsed.ins[0].hash).reverse().toString('hex'), txid);
  assert(
    parsed.outs.some(
      (o) => o.value === 10000n && bitcoin.address.fromOutputScript(o.script) === recipient,
    ),
  );
  assert(
    parsed.outs.some(
      (o) => o.value === 20000n && bitcoin.address.fromOutputScript(o.script) === w.address,
    ),
  );
  const fee = 100000n - parsed.outs.reduce((n, o) => n + o.value, 0n);
  assert(fee >= BigInt(parsed.virtualSize() * 2));
  assert(fee < 2000n);
  const [signature, pubkey] = parsed.ins[0].witness;
  const decoded = bitcoin.script.signature.decode(signature);
  const scriptCode = bitcoin.payments.p2pkh({ pubkey }).output!;
  assert(
    verify(
      parsed.hashForWitnessV0(0, scriptCode, 100000n, decoded.hashType),
      pubkey,
      decoded.signature,
    ),
  );
});
test('Solana signed transfer verifies and preserves lamports', () => {
  const w = wallet('solana');
  const signed = core.sign({
    wallet: w,
    transaction: {
      chain: 'solana',
      outputs: [{ address: w.address, amount: '1000000001' }],
      recentBlockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    },
  });
  const raw = Buffer.from(signed.raw, 'base64');
  assert.equal(raw[0], 1);
  const message = raw.subarray(65);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), message.subarray(4, 36)]),
    format: 'der',
    type: 'spki',
  });
  assert(verifyEd25519(null, message, publicKey, raw.subarray(1, 65)));
  assert.equal(message.readBigUInt64LE(message.length - 8), 1000000001n);
});
test('rejects arbitrary paths, private key injection, mixed chains and numeric amounts', () => {
  assert.equal(
    transferSchema.safeParse({ chain: 'solana', to: wallet('solana').address, amount: 10 }).success,
    false,
  );
  assert.equal(
    signSchema.safeParse({ wallet: { ...wallet('solana'), path: "m/0'" }, transaction: {} })
      .success,
    false,
  );
  assert.throws(() => core.derive({ chain: 'ethereum', account: 0, seedId: 'wrong' }));
  const request = {
    wallet: wallet('ethereum'),
    transaction: {
      chain: 'ethereum' as const,
      chainId: '1',
      nonce: '0',
      to: wallet('ethereum').address,
      amount: '1',
      gasLimit: '21000',
      maxFeePerGas: '2',
      maxPriorityFeePerGas: '1',
    },
  };
  assert.throws(() => core.sign(request), /chain ID/);
  assert.throws(
    () => core.sign({ ...request, wallet: { ...request.wallet, address: '0x' + '00'.repeat(20) } }),
    /does not match/,
  );
});
test('Bitcoin rejects duplicate and foreign UTXOs', () => {
  const w = wallet('bitcoin');
  const u = { txid: '02'.repeat(32), vout: 0, amount: '100000', script: '0014' + '00'.repeat(20) };
  const transaction = {
    chain: 'bitcoin' as const,
    outputs: [{ address: w.address, amount: '10000' }],
    utxos: [u],
    satsPerVbyte: 1,
  };
  assert.throws(() => core.sign({ wallet: w, transaction }), /not owned/);
  assert.throws(
    () => core.sign({ wallet: w, transaction: { ...transaction, utxos: [u, u] } }),
    /Duplicate/,
  );
});
test('Solana batches 20 native transfers in one independently verified transaction', () => {
  const w = wallet('solana');
  const outputs = Array.from({ length: 20 }, (_, i) => ({
    address: core.derive({ chain: 'solana', account: i + 1, seedId: 'test' }).address,
    amount: String(i + 1),
  }));
  const signed = core.sign({
    wallet: w,
    transaction: {
      chain: 'solana',
      outputs,
      recentBlockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    },
  });
  const raw = Buffer.from(signed.raw, 'base64'),
    message = raw.subarray(65);
  assert(raw.length <= 1232);
  assert.equal(message[3], 22);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), message.subarray(4, 36)]),
    format: 'der',
    type: 'spki',
  });
  assert(verifyEd25519(null, message, publicKey, raw.subarray(1, 65)));
  let offset = 4 + 22 * 32 + 32;
  assert.equal(message[offset++], 20);
  for (let i = 0; i < 20; i++) {
    assert.equal(message[offset++], 21);
    assert.equal(message[offset++], 2);
    assert.equal(message[offset++], 0);
    assert.equal(message[offset++], i + 1);
    assert.equal(message[offset++], 12);
    assert.equal(message.readUInt32LE(offset), 2);
    offset += 4;
    assert.equal(message.readBigUInt64LE(offset), BigInt(i + 1));
    offset += 8;
  }
  assert.equal(offset, message.length);
});
test('invalid decimal strings fail validation without BigInt exceptions', () => {
  for (const amount of ['garbage', '-1', '1.5', '1e6', '0', '9'.repeat(1000)]) {
    assert.equal(
      transferSchema.safeParse({
        chain: 'solana',
        outputs: [{ address: wallet('solana').address, amount }],
      }).success,
      false,
    );
  }
});
