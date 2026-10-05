import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction as EthTransaction } from 'ethers';
const bitcoinPromise = import('bitcoinjs-lib');
let bitcoin: Awaited<typeof bitcoinPromise>;
import { verify } from '@bitcoinerlab/secp256k1';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { derivationRequestDigest, walletDeriveSchema } from '../packages/queue/src/messages.js';
import {
  canonicalizeDerivedAddress,
  coreDerivationPath,
} from '../packages/chain/src/coin-metadata.js';
import { randomUUID } from 'node:crypto';
import { initWasm } from '@trustwallet/wallet-core';
import {
  derivationPath,
  signSchema,
  supportedChains,
  transferSchema,
} from '../packages/shared/src/contracts.js';

// Public BIP39 test vector. Never use this phrase for funds.
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let core: SigningCore;
let walletCore: Awaited<ReturnType<typeof initWasm>>;
before(async () => {
  bitcoin = await bitcoinPromise;
  walletCore = await initWasm();
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
  assert.equal(derivationPath('solana', 0), "m/44'/501'/0'");
  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const)
    assert.notEqual(
      wallet(chain).address,
      core.derive({ chain, account: 1, seedId: 'test' }).address,
    );
  assert.throws(() => derivationPath('ethereum', -1));
  assert.throws(() => derivationPath('ethereum', 2147483648));
});

test('exchange hot, management, and customer accounts use the hardened account component', () => {
  const paths = {
    ethereum: (account: number) => `m/44'/60'/${account}'/0/0`,
    bitcoin: (account: number) => `m/84'/0'/${account}'/0/0`,
    solana: (account: number) => `m/44'/501'/${account}'`,
  };
  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const) {
    for (const account of [0, 1, 9, 10]) {
      const derived = core.derive({ chain, account, seedId: 'test' });
      assert.equal(derived.path, paths[chain](account));
      assert.equal(derivationPath(chain, account), paths[chain](account));
      assert.ok(derived.address);
    }
  }
});

test('every enabled Wallet Core coin derives a wallet address', () => {
  for (const chain of supportedChains) {
    const derived = core.derive({ chain, account: 0, seedId: 'test' });
    assert.ok(derived.address, chain);
    assert.ok(derived.path.startsWith('m/'), chain);
  }
});

test('EVM family derives and signs Polygon transactions with its configured chain ID', async () => {
  const evmCore = await SigningCore.create(mnemonic, 'test', '11155111', {
    ethereum: '11155111',
    polygon: '137',
  });
  try {
    const { path, ...polygonWallet } = evmCore.derive({
      chain: 'polygon',
      account: 0,
      seedId: 'test',
    });
    assert.equal(path, "m/44'/60'/0'/0/0");
    const signed = evmCore.sign({
      wallet: polygonWallet,
      transaction: {
        chain: 'polygon',
        chainId: '137',
        nonce: '0',
        to: polygonWallet.address,
        amount: '1',
        gasLimit: '21000',
        maxFeePerGas: '2',
        maxPriorityFeePerGas: '1',
      },
    });
    const parsed = EthTransaction.from(signed.raw);
    assert.equal(parsed.from, polygonWallet.address);
    assert.equal(parsed.chainId, 137n);
    assert.equal(parsed.hash, signed.txHash);
    assert.throws(
      () =>
        core.sign({
          wallet: polygonWallet,
          transaction: {
            chain: 'polygon',
            chainId: '137',
            nonce: '0',
            to: polygonWallet.address,
            amount: '1',
            gasLimit: '21000',
            maxFeePerGas: '2',
            maxPriorityFeePerGas: '1',
          },
        }),
      /chain ID/,
    );
  } finally {
    evmCore.close();
  }
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

test('Bitcoin Cash family signs using its coin-specific address and Wallet Core coin type', () => {
  const { path: _path, ...cashWallet } = core.derive({
    chain: 'bitcoinCash',
    account: 0,
    seedId: 'test',
  });
  const recipient = core.derive({ chain: 'bitcoinCash', account: 1, seedId: 'test' }).address;
  const script = walletCore.BitcoinScript.lockScriptForAddress(
    cashWallet.address,
    walletCore.CoinType.bitcoinCash,
  );
  let ownScript: string;
  try {
    ownScript = Buffer.from(script.data()).toString('hex');
  } finally {
    script.delete();
  }
  const signed = core.sign({
    wallet: cashWallet,
    transaction: {
      chain: 'bitcoinCash',
      outputs: [{ address: recipient, amount: '10000' }],
      utxos: [{ txid: '02'.repeat(32), vout: 0, amount: '100000', script: ownScript }],
      satsPerVbyte: 2,
    },
  });
  assert.equal(signed.encoding, 'hex');
  assert.match(signed.raw, /^[0-9a-f]+$/);
  assert.match(signed.txHash, /^[0-9a-f]{64}$/);
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

test('bound derivation authenticates domain, seed, network, role, and exact path without emitting secrets', async () => {
  const policy = {
    domainId: 'exchange-development',
    chainNetworks: {
      ethereum: { network: '11155111', chainId: '11155111' },
      bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
      solana: { network: 'devnet', genesisHash: 'devnet' },
    },
  };
  const bound = await SigningCore.create(mnemonic, 'test', '11155111', undefined, policy);
  const service = new SigningService(bound);
  try {
    for (const chain of ['ethereum', 'bitcoin', 'solana'] as const) {
      for (const account of [0, 1, 9, 10, 2147483647]) {
        const binding = {
          walletId: randomUUID(),
          requestId: randomUUID(),
          domainId: policy.domainId,
          network: policy.chainNetworks[chain].network,
          role:
            account === 0
              ? ('hot' as const)
              : account <= 9
                ? ('management' as const)
                : ('customer_deposit' as const),
          request: { chain, account, seedId: 'test' },
          path: await coreDerivationPath(chain, account, policy.chainNetworks[chain].network),
        };
        const action = walletDeriveSchema.parse({
          ...binding,
          type: 'wallet.derive',
          requestDigest: derivationRequestDigest(binding),
        });
        const result = service.execute(action);
        assert.equal(result.type, 'wallet.derived');
        if (result.type !== 'wallet.derived') throw new Error('Unexpected rejection');
        assert.deepEqual(result.request, action.request);
        assert.equal(result.requestId, action.requestId);
        assert.equal(result.requestDigest, action.requestDigest);
        assert.equal(result.domainId, policy.domainId);
        assert.equal(result.path, binding.path);
        assert.equal(JSON.stringify(result).includes(mnemonic), false);
        assert.equal(JSON.stringify(result).includes('privateKey'), false);
        assert.equal(
          result.address,
          await canonicalizeDerivedAddress(chain, binding.network, result.address),
        );
        if (chain === 'bitcoin') {
          assert.match(result.path, /^m\/84'\/1'\//);
          assert.match(result.address, /^bcrt1q/);
        }
        for (const changed of [
          { domainId: 'other-exchange' },
          { network: 'wrong-network' },
          { path: "m/0'" },
          { request: { ...action.request, seedId: 'wrong-seed' } },
        ]) {
          const invalidBinding = { ...binding, ...changed };
          const invalid = walletDeriveSchema.parse({
            ...invalidBinding,
            type: 'wallet.derive',
            requestDigest: derivationRequestDigest(invalidBinding),
          });
          assert.deepEqual(service.execute(invalid), { ...invalid, type: 'wallet.rejected' });
        }
      }
    }
  } finally {
    bound.close();
  }
});

test('Bitcoin regtest signs exact witness scripts and rejects cross-network or omitted network identity', async () => {
  const regtest = await SigningCore.create(mnemonic, 'test', '11155111', undefined, {
    domainId: 'regtest-test',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  });
  try {
    const { path: _path, ...source } = regtest.derive({
      chain: 'bitcoin',
      account: 10,
      seedId: 'test',
    });
    const target = regtest.derive({ chain: 'bitcoin', account: 0, seedId: 'test' });
    assert.equal(target.address, 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk');
    const sourceScript = bitcoin.address.toOutputScript(source.address, bitcoin.networks.regtest);
    const targetScript = bitcoin.address.toOutputScript(target.address, bitcoin.networks.regtest);
    const transaction = {
      chain: 'bitcoin' as const,
      outputs: [{ address: target.address, amount: '10000' }],
      utxos: [
        {
          txid: '02'.repeat(32),
          vout: 0,
          amount: '100000',
          script: Buffer.from(sourceScript).toString('hex'),
        },
      ],
      satsPerVbyte: 2,
    };
    const signed = regtest.sign({ wallet: { ...source, network: 'regtest' }, transaction });
    const parsed = bitcoin.Transaction.fromHex(signed.raw);
    assert.equal(parsed.getId(), signed.txHash);
    assert.equal(parsed.outs.length, 2);
    assert.equal(parsed.outs[0].value, 10000n);
    assert.deepEqual(parsed.outs[0].script, targetScript);
    assert.deepEqual(parsed.outs[1].script, sourceScript);
    const [signature, pubkey] = parsed.ins[0].witness;
    const decoded = bitcoin.script.signature.decode(signature);
    assert(
      verify(
        parsed.hashForWitnessV0(
          0,
          bitcoin.payments.p2pkh({ pubkey }).output!,
          100000n,
          decoded.hashType,
        ),
        pubkey,
        decoded.signature,
      ),
    );
    const fee = 100000n - parsed.outs.reduce((sum, out) => sum + out.value, 0n);
    assert(fee >= BigInt(parsed.virtualSize() * 2));
    assert(fee < 2000n);
    assert.throws(() => regtest.sign({ wallet: source, transaction }), /network/);
    assert.throws(
      () => regtest.sign({ wallet: { ...source, network: 'mainnet' }, transaction }),
      /network/,
    );
    assert.throws(
      () =>
        regtest.sign({
          wallet: { ...source, network: 'regtest' },
          transaction: {
            ...transaction,
            outputs: [{ address: wallet('bitcoin').address, amount: '10000' }],
          },
        }),
      /regtest/,
    );
    await assert.rejects(canonicalizeDerivedAddress('bitcoin', 'mainnet', source.address));
    await assert.rejects(
      canonicalizeDerivedAddress('bitcoin', 'regtest', wallet('bitcoin').address),
    );
    const altered = source.address.slice(0, -1) + (source.address.endsWith('q') ? 'p' : 'q');
    await assert.rejects(canonicalizeDerivedAddress('bitcoin', 'regtest', altered));
  } finally {
    regtest.close();
  }
});
