import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { Transaction as EvmTransaction } from 'ethers';
import { Transaction as BitcoinTransaction } from 'bitcoinjs-lib';
import { getWalletCore } from '../packages/chain/src/coin-metadata.js';
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import {
  NativeSweepPlanner,
  SweepDeferral,
  bitcoinDecimalUnits,
  nativeSolanaMessage,
} from '../packages/chain/src/native-sweep-planner.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { regtestWitnessAddress } from '../packages/chain/src/bitcoin-address.js';
import { Chain, SignRequest } from '../packages/shared/src/contracts.js';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SYSTEM = '11111111111111111111111111111111';
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ethSource = '0x' + '11'.repeat(20);
const ethHot = '0x' + '22'.repeat(20);
const blockHash = '0x' + '44'.repeat(32);
const btcBlock = '55'.repeat(32);
const blockhash = '11111111111111111111111111111111';
let signer: SigningCore;
before(async () => {
  signer = await SigningCore.create(mnemonic, 'sweep-test', '11155111', undefined, {
    domainId: 'sweep-test',
    chainNetworks: {
      ethereum: { network: '11155111', chainId: '11155111' },
      bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
      solana: { network: DEVNET, genesisHash: DEVNET },
    },
  });
});
after(() => signer.close());

function wallet(chain: 'bitcoin' | 'solana', account: number) {
  const { path: _path, ...w } = signer.derive({ chain, account, seedId: 'sweep-test' });
  return { ...w, network: chain === 'bitcoin' ? 'regtest' : DEVNET };
}

class FakeRpc extends ChainRpcService {
  readonly calls: { chain: Chain; method: string; params: unknown[] }[] = [];
  constructor(public handle: (method: string, params: unknown[]) => unknown | Promise<unknown>) {
    super({
      ethereumChainId: '11155111',
      solanaGenesisHash: DEVNET,
      chainNetworks: {
        ethereum: { network: '11155111', chainId: '11155111' },
        bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
        solana: { network: DEVNET, genesisHash: DEVNET },
      },
    });
  }

  override async call(chain: Chain, method: string, params: unknown[]) {
    this.calls.push({ chain, method, params });
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    if (method === 'getGenesisHash') return DEVNET;
    return this.handle(method, params);
  }
}
const expectDeferral = (code: string) => (error: unknown) =>
  error instanceof SweepDeferral && error.code === code;

function ethRpc(overrides: Record<string, unknown> = {}) {
  return new FakeRpc((method, params) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'eth_getBalance':
        return '0x' + (10n ** 18n).toString(16);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getBlockByNumber':
        return {
          hash: blockHash,
          number: params[0] === 'finalized' ? '0x20' : '0x10',
          baseFeePerGas: '0x3b9aca00',
        };
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_getCode':
        return '0x';
      case 'eth_estimateGas':
        return '0x5208';
      default:
        throw new Error(`Unexpected RPC ${method}`);
    }
  });
}

test('native planner verifies pinned RPC identity before any balances and rejects unsupported networks', async () => {
  const rpc = ethRpc();
  const planner = new NativeSweepPlanner(rpc);
  await assert.rejects(
    planner.plan({ chain: 'ethereum', network: '1', sourceAddress: ethSource, hotAddress: ethHot }),
    expectDeferral('attention'),
  );
  assert.equal(rpc.calls.length, 0);
  await planner.plan({
    chain: 'ethereum',
    network: '11155111',
    sourceAddress: ethSource,
    hotAddress: ethHot,
  });
  assert.equal(rpc.calls[0].method, 'eth_chainId');
});

test('Ethereum sweep reserves worst-case gas and uses the smaller finalized/pending balance', async () => {
  const available = 2n * 10n ** 17n;
  const rpc = ethRpc();
  const base = rpc.handle;
  rpc.handle = (method, params) =>
    method === 'eth_getBalance' && params[1] === 'pending'
      ? '0x' + available.toString(16)
      : base(method, params);
  const plan = await new NativeSweepPlanner(rpc).plan({
    chain: 'ethereum',
    network: '11155111',
    sourceAddress: ethSource,
    hotAddress: ethHot,
  });
  assert.equal(plan.maxFeeUnits, String(25200n * 3_000_000_000n));
  assert.equal(BigInt(plan.amount) + BigInt(plan.maxFeeUnits), available);
  assert.deepEqual(plan.resourceKeys, [`nonce:${ethSource}:7`]);
  assert.equal(plan.request.chain, 'ethereum');
  assert.equal('to' in plan.request && plan.request.to, ethHot);
  assert(Number.isFinite(Date.parse(plan.expiresAt)));
  assert(
    rpc.calls.some((call) => call.method === 'eth_getBalance' && call.params[1] === 'finalized'),
  );
});

test('Ethereum unknown pending nonce, excessive gas quotes, dust, and contract hot wallets defer safely', async () => {
  const pending = ethRpc();
  const handle = pending.handle;
  pending.handle = (method, params) =>
    method === 'eth_getTransactionCount' && params[1] === 'pending'
      ? '0x8'
      : handle(method, params);
  await assert.rejects(
    new NativeSweepPlanner(pending).plan({
      chain: 'ethereum',
      network: '11155111',
      sourceAddress: ethSource,
      hotAddress: ethHot,
    }),
    expectDeferral('attention'),
  );
  for (const [overrides, code] of [
    [{ eth_maxPriorityFeePerGas: '0xb2d05e00' }, 'fee_budget'],
    [{ eth_getBalance: '0x3e8' }, 'insufficient_balance'],
    [{ eth_getBalance: '0x38d7ea4c68000' }, 'dust'],
    [{ eth_getBalance: '0x11c37937e08000' }, 'fee_budget'],
    [{ eth_getCode: '0x6000' }, 'attention'],
  ] as const)
    await assert.rejects(
      new NativeSweepPlanner(ethRpc(overrides)).plan({
        chain: 'ethereum',
        network: '11155111',
        sourceAddress: ethSource,
        hotAddress: ethHot,
      }),
      expectDeferral(code),
    );
});

test('Bitcoin decimal conversion never rounds values or loses a fractional satoshi', () => {
  assert.equal(bitcoinDecimalUnits(0.00000001), 1n);
  assert.equal(bitcoinDecimalUnits('1.12345678'), 112345678n);
  assert.equal(bitcoinDecimalUnits('1e-8'), 1n);
  assert.equal(bitcoinDecimalUnits('0.0000000100'), 1n);
  assert.throws(() => bitcoinDecimalUnits(0.10000000000000002), /precision/);
  assert.throws(() => bitcoinDecimalUnits('0.000000001'), /precision/);
  assert.throws(() => bitcoinDecimalUnits('21000001'), /supply/);
  assert.throws(() => bitcoinDecimalUnits(NaN));
});

function btcRpc(
  options: {
    count?: number;
    value?: unknown;
    confirmations?: number;
    coinbase?: boolean;
    spent?: boolean;
    foreign?: boolean;
    rate?: unknown;
    error?: unknown;
  } = {},
) {
  const source = wallet('bitcoin', 10);
  const script =
    '0014' + Buffer.from(regtestWitnessAddress(source.address).program).toString('hex');
  const candidates = Array.from({ length: options.count ?? 1 }, (_, i) => ({
    txid: (i + 1).toString(16).padStart(64, '0'),
    vout: 0,
    address: source.address,
    confirmations: 6,
  }));
  return new FakeRpc((method) => {
    switch (method) {
      case 'listunspent':
        return candidates;
      case 'gettxout':
        return options.spent
          ? null
          : {
              value: options.value ?? '0.00100000',
              confirmations: options.confirmations ?? 6,
              coinbase: options.coinbase ?? false,
              scriptPubKey: {
                hex: options.foreign ? '0014' + 'ff'.repeat(20) : script,
                address: source.address,
              },
            };
      case 'estimatesmartfee':
        if (options.error) throw options.error;
        return options.rate === undefined
          ? { errors: ['Insufficient data'] }
          : { feerate: options.rate };
      default:
        throw new Error(`Unexpected ${method}`);
    }
  });
}

test('Bitcoin watch-only sweep uses all selected inputs, one hot output, exact Wallet Core fee, and stable reservations', async () => {
  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  const rpc = btcRpc({ count: 2 });
  const plan = await new NativeSweepPlanner(rpc).plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  assert.equal(plan.request.chain, 'bitcoin');
  assert('utxos' in plan.request);
  assert.equal(plan.request.utxos.length, 2);
  assert.equal(plan.request.sweepAll, true);
  assert.equal(plan.request.outputs.length, 1);
  assert.equal(plan.request.outputs[0].address, hot.address);
  assert.equal(BigInt(plan.amount) + BigInt(plan.maxFeeUnits), 200000n);
  assert(BigInt(plan.maxFeeUnits) < 2000n);
  assert.deepEqual(
    plan.resourceKeys,
    plan.request.utxos.map((u) => `utxo:${u.txid}:${u.vout}`),
  );
  assert.deepEqual(rpc.calls.find((call) => call.method === 'listunspent')?.params, [
    6,
    9_999_999,
    [source.address],
    false,
  ]);
  const signed = signer.sign({ wallet: source, transaction: plan.request });
  assert(signed.raw.length > 0);
  assert.equal(signed.encoding, 'hex');
});

test('Bitcoin maturity, mempool spend, precision and ownership checks precede signing; fee RPC failure never uses fallback', async () => {
  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  const plan = (options: Parameters<typeof btcRpc>[0]) =>
    new NativeSweepPlanner(btcRpc(options)).plan({
      chain: 'bitcoin',
      network: 'regtest',
      sourceAddress: source.address,
      hotAddress: hot.address,
    });
  await assert.rejects(
    plan({ coinbase: true, confirmations: 99 }),
    expectDeferral('insufficient_balance'),
  );
  await assert.rejects(plan({ confirmations: 5 }), expectDeferral('insufficient_balance'));
  await assert.rejects(plan({ spent: true }), expectDeferral('insufficient_balance'));
  await assert.rejects(plan({ foreign: true }), /script/);
  await assert.rejects(plan({ value: 0.10000000000000002 }), /precision/);
  await assert.rejects(plan({ error: new RpcFailure() }), expectDeferral('unavailable'));
  await assert.rejects(plan({ rate: '0.00101' }), expectDeferral('fee_budget'));
  assert((await plan({ coinbase: true, confirmations: 100 })).amount);
});

test('Bitcoin large sets produce chunks of at most 100 distinct outpoints', async () => {
  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  await assert.rejects(
    new NativeSweepPlanner(btcRpc({ count: 101 })).plan({
      chain: 'bitcoin',
      network: 'regtest',
      sourceAddress: source.address,
      hotAddress: hot.address,
    }),
    expectDeferral('fee_budget'),
  );
  // A rate of one sat/vbyte keeps the 100-input chunk inside the fixed fee cap.
  const plan = await new NativeSweepPlanner(btcRpc({ count: 101, rate: '0.00001' })).plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  assert.equal(plan.resourceKeys.length, 100);
  assert.equal(new Set(plan.resourceKeys).size, 100);
});

function solRpc(
  options: {
    owner?: string;
    executable?: boolean;
    data?: string;
    balance?: number;
    rent?: number;
    fee?: number | null;
    height?: number;
    feeContext?: number;
    blockhashValid?: boolean;
  } = {},
) {
  return new FakeRpc((method) => {
    switch (method) {
      case 'getBalance':
        return { context: { slot: 100 }, value: options.balance ?? 100_000_000 };
      case 'getAccountInfo':
        return {
          context: { slot: 100 },
          value: {
            owner: options.owner ?? SYSTEM,
            executable: options.executable ?? false,
            lamports: options.balance ?? 100_000_000,
            data: [options.data ?? '', 'base64'],
          },
        };
      case 'getLatestBlockhash':
        return { context: { slot: 101 }, value: { blockhash, lastValidBlockHeight: 1000 } };
      case 'getMinimumBalanceForRentExemption':
        return options.rent ?? 890880;
      case 'getFeeForMessage':
        return {
          context: { slot: options.feeContext ?? 101 },
          value: 'fee' in options ? options.fee : 5000,
        };
      case 'getBlockHeight':
        return options.height ?? 990;
      case 'isBlockhashValid':
        return {
          context: { slot: options.feeContext ?? 101 },
          value: options.blockhashValid ?? true,
        };
      default:
        throw new Error(`Unexpected ${method}`);
    }
  });
}

test('Solana sweeps retain rent, quote the exact native message, and preserve blockhash validity', async () => {
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  const rpc = solRpc();
  const plan = await new NativeSweepPlanner(rpc).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  assert.equal(plan.amount, String(100_000_000 - 890880 - 5000));
  assert.equal(plan.maxFeeUnits, '5000');
  assert.equal(plan.lastValidBlockHeight, 1000);
  assert.deepEqual(plan.resourceKeys, [`balance:${source.address}`]);
  assert.equal(plan.request.chain, 'solana');
  assert('recentBlockhash' in plan.request);
  const message = await nativeSolanaMessage(
    source.address,
    hot.address,
    blockhash,
    BigInt(plan.amount),
  );
  const quotes = rpc.calls.filter((call) => call.method === 'getFeeForMessage');
  assert.equal(quotes.length, 2);
  assert.equal(quotes[1].params[0], message.toString('base64'));
  const signed = signer.sign({ wallet: source, transaction: plan.request });
  assert.deepEqual(Buffer.from(signed.raw, 'base64').subarray(65), message);
});

test('Solana program ownership, data, rent, expired blockhash and stale fee context defer', async () => {
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  for (const [options, code] of [
    [{ owner: hot.address }, 'attention'],
    [{ executable: true }, 'attention'],
    [{ data: 'AA==' }, 'attention'],
    [{ rent: 5_000_001 }, 'fee_budget'],
    [{ fee: null }, 'unavailable'],
    [{ feeContext: 99 }, 'unavailable'],
    [{ height: 1000 }, 'unavailable'],
    [{ balance: 100 }, 'insufficient_balance'],
    [{ fee: 100_001 }, 'fee_budget'],
  ] as const)
    await assert.rejects(
      new NativeSweepPlanner(solRpc(options)).plan({
        chain: 'solana',
        network: DEVNET,
        sourceAddress: source.address,
        hotAddress: hot.address,
      }),
      expectDeferral(code),
    );
});

async function ethereumObservation(status = '0x1') {
  const derived = signer.derive({ chain: 'ethereum', account: 10, seedId: 'sweep-test' });
  const source = derived.address.toLowerCase();
  const hot = signer
    .derive({ chain: 'ethereum', account: 0, seedId: 'sweep-test' })
    .address.toLowerCase();
  const plan = await new NativeSweepPlanner(ethRpc()).plan({
    chain: 'ethereum',
    network: '11155111',
    sourceAddress: source,
    hotAddress: hot,
  });
  const transaction = plan.request;
  assert('to' in transaction);
  const request: SignRequest = {
    wallet: {
      chain: 'ethereum',
      account: 10,
      seedId: 'sweep-test',
      address: source,
      network: '11155111',
    },
    transaction,
  };
  const signed = signer.sign(request);
  const hash = signed.txHash;
  const receipt = {
    transactionHash: hash,
    blockHash,
    blockNumber: '0x10',
    status,
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
  };
  const rpc = ethRpc({
    eth_getTransactionReceipt: receipt,
    eth_getTransactionByHash: {
      hash,
      from: source,
      to: hot,
      value: '0x' + BigInt(transaction.amount).toString(16),
      nonce: '0x7',
      input: '0x',
      blockHash,
      blockNumber: '0x10',
    },
  });
  return { rpc, input: { chain: 'ethereum' as const, network: '11155111', hash, request, signed } };
}

test('Ethereum execution requires canonical finalized inclusion and records the actual fee even on failure', async () => {
  for (const status of ['0x1', '0x0']) {
    const { rpc, input } = await ethereumObservation(status);
    const result = await new NativeSweepPlanner(rpc).observe(input);
    assert.equal(result.state, status === '0x1' ? 'confirmed' : 'failed');
    assert.equal(result.actualFeeUnits, '21000000000000');
    assert.equal(result.blockHeight, '16');
    assert.equal(result.blockHash, blockHash);
  }
});

test('Execution observation never treats RPC outages or missing canonical data as reorgs; prior inclusion proves orphan', async () => {
  const { rpc, input } = await ethereumObservation();
  const original = rpc.handle;
  rpc.handle = (method, params) =>
    method === 'eth_getBlockByNumber' ? null : original(method, params);
  await assert.rejects(new NativeSweepPlanner(rpc).observe(input), /unavailable/);
  rpc.handle = (method, params) =>
    method === 'eth_getBlockByNumber'
      ? { hash: '0x' + '66'.repeat(32), number: '0x10' }
      : original(method, params);
  assert.equal(
    (
      await new NativeSweepPlanner(rpc).observe({
        ...input,
        priorInclusion: { blockHash, blockHeight: '16' },
      })
    ).state,
    'reverted',
  );
  rpc.handle = (method, params) =>
    method === 'eth_getTransactionReceipt' ? null : original(method, params);
  assert.equal(
    (
      await new NativeSweepPlanner(rpc).observe({
        ...input,
        priorInclusion: { blockHash, blockHeight: '16' },
      })
    ).state,
    'pending',
  );
  await assert.rejects(
    new NativeSweepPlanner(rpc).observe({ ...input, hash: '0x' + 'ff'.repeat(32) }),
    /signed transaction hash/,
  );
});

test('Bitcoin canonical execution decodes exact signed hot output and charges fee from reserved inputs', async () => {
  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  const plan = await new NativeSweepPlanner(btcRpc()).plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const signed = signer.sign(request);
  let confirmations = 5;
  let canonical = btcBlock;
  const rpc = new FakeRpc((method) => {
    switch (method) {
      case 'getrawtransaction':
        return { txid: signed.txHash, hex: signed.raw, blockhash: btcBlock };
      case 'getblockheader':
        return { hash: btcBlock, height: 50, confirmations };
      case 'getblockhash':
        return canonical;
      default:
        throw new Error(method);
    }
  });
  const input = {
    chain: 'bitcoin' as const,
    network: 'regtest',
    hash: signed.txHash,
    request,
    signed,
  };
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'pending');
  confirmations = 6;
  const result = await new NativeSweepPlanner(rpc).observe(input);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.actualFeeUnits, plan.maxFeeUnits);
  canonical = '66'.repeat(32);
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'reverted');
  canonical = btcBlock;
  confirmations = -1;
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'reverted');
});

test('Solana finalized execution verifies exact signed bytes and canonical signature membership, including charged failures', async () => {
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  const plan = await new NativeSweepPlanner(solRpc()).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const signed = signer.sign(request);
  let err: unknown = null;
  let signatures = [signed.txHash];
  const rpc = new FakeRpc((method) => {
    if (method === 'getTransaction')
      return { slot: 200, transaction: [signed.raw, 'base64'], meta: { err, fee: 5000 } };
    if (method === 'getBlock') return { blockhash, signatures };
    throw new Error(method);
  });
  const input = { chain: 'solana' as const, network: DEVNET, hash: signed.txHash, request, signed };
  assert.deepEqual(await new NativeSweepPlanner(rpc).observe(input), {
    state: 'confirmed',
    blockHash: blockhash,
    blockHeight: '200',
    actualFeeUnits: '5000',
  });
  err = { InstructionError: [0, 'Custom'] };
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'failed');
  signatures = [];
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'reverted');
});

test('Ethereum included execution remains pending before finalized height and rechecks inclusion after RPC reads', async () => {
  const { rpc, input } = await ethereumObservation('0x0');
  const original = rpc.handle;
  rpc.handle = (method, params) =>
    method === 'eth_getBlockByNumber' && params[0] === 'finalized'
      ? { hash: blockHash, number: '0xf' }
      : original(method, params);
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'pending');
  let checks = 0;
  rpc.handle = (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x10' && ++checks === 2)
      return { hash: '0x' + 'ff'.repeat(32), number: '0x10' };
    return original(method, params);
  };
  assert.equal((await new NativeSweepPlanner(rpc).observe(input)).state, 'reverted');
});

test('Native observations reject changed execution bytes or destination amounts instead of settling them', async () => {
  const { rpc, input } = await ethereumObservation();
  await assert.rejects(
    new NativeSweepPlanner(rpc).observe({
      ...input,
      signed: { ...input.signed, raw: input.signed.raw.slice(0, -2) + 'ff' },
    }),
    /raw hash/,
  );
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  const plan = await new NativeSweepPlanner(solRpc()).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const signed = signer.sign(request);
  assert('recentBlockhash' in request.transaction);
  const changed: SignRequest = {
    ...request,
    transaction: { ...request.transaction, outputs: [{ address: hot.address, amount: '1' }] },
  };
  await assert.rejects(
    new NativeSweepPlanner(solRpc()).observe({
      chain: 'solana',
      network: DEVNET,
      hash: signed.txHash,
      request: changed,
      signed,
    }),
    /exact System transfer/,
  );
});

test('Bitcoin and Solana prior inclusion checks preserve evidence on outage and prove orphaned heights', async () => {
  for (const chain of ['bitcoin', 'solana'] as const) {
    const source = wallet(chain, 10);
    const hot = wallet(chain, 0);
    const network = chain === 'bitcoin' ? 'regtest' : DEVNET;
    const plan = await new NativeSweepPlanner(chain === 'bitcoin' ? btcRpc() : solRpc()).plan({
      chain,
      network,
      sourceAddress: source.address,
      hotAddress: hot.address,
    });
    const request: SignRequest = { wallet: source, transaction: plan.request };
    const signed = signer.sign(request);
    const previous = chain === 'bitcoin' ? btcBlock : blockhash;
    const unavailable = new FakeRpc(() => {
      throw new RpcFailure();
    });
    const input = {
      chain,
      network,
      hash: signed.txHash,
      request,
      signed,
      priorInclusion: { blockHash: previous, blockHeight: '50' },
    };
    await assert.rejects(new NativeSweepPlanner(unavailable).observe(input), RpcFailure);
    const orphaned = new FakeRpc(() =>
      chain === 'bitcoin' ? '66'.repeat(32) : { blockhash: hot.address },
    );
    assert.equal((await new NativeSweepPlanner(orphaned).observe(input)).state, 'reverted');
    const missing = new FakeRpc((method) => {
      if (method === 'getblockhash') return btcBlock;
      if (method === 'getBlock') return { blockhash };
      if (method === 'getrawtransaction') throw new RpcFailure(-5);
      if (method === 'getTransaction') return null;
      throw new Error(method);
    });
    assert.equal((await new NativeSweepPlanner(missing).observe(input)).state, 'pending');
  }
});

test('Ethereum revalidation preserves exact principal while rechecking nonce, balances, hot ownership and live fees', async () => {
  const rpc = ethRpc();
  const planner = new NativeSweepPlanner(rpc);
  const plan = await planner.plan({
    chain: 'ethereum',
    network: '11155111',
    sourceAddress: ethSource,
    hotAddress: ethHot,
  });
  const request: SignRequest = {
    wallet: {
      chain: 'ethereum',
      account: 10,
      seedId: 'sweep-test',
      address: ethSource,
      network: '11155111',
    },
    transaction: plan.request,
  };
  await planner.revalidate(request, plan.maxFeeUnits);
  for (const [overrides, code] of [
    [{ eth_getTransactionCount: '0x8' }, 'waiting_resources'],
    [{ eth_getBalance: '0x3e8' }, 'waiting_funds'],
    [{ eth_getCode: '0x6000' }, 'attention'],
    [{ eth_getBlockByNumber: { baseFeePerGas: '0xb2d05e00' } }, 'fee_budget'],
    [{ eth_maxPriorityFeePerGas: '0x77359400' }, 'fee_budget'],
    [{ eth_estimateGas: '0x186a0' }, 'fee_budget'],
  ] as const)
    await assert.rejects(
      new NativeSweepPlanner(ethRpc(overrides)).revalidate(request, plan.maxFeeUnits),
      expectDeferral(code),
    );
  await assert.rejects(
    planner.revalidate(request, String(BigInt(plan.maxFeeUnits) + 1n)),
    expectDeferral('fee_budget'),
  );
  const original = rpc.handle;
  rpc.handle = (method, params) =>
    method === 'eth_getTransactionCount' && params[1] === 'pending'
      ? '0x8'
      : original(method, params);
  await assert.rejects(
    planner.revalidate(request, plan.maxFeeUnits),
    expectDeferral('waiting_resources'),
  );
  rpc.handle = (method, params) =>
    method === 'eth_getBalance' && params[1] === 'finalized' ? '0x3e8' : original(method, params);
  await assert.rejects(
    planner.revalidate(request, plan.maxFeeUnits),
    expectDeferral('waiting_funds'),
  );
});

test('Bitcoin revalidation checks the exact reserved outpoints and keeps new arrivals outside the attempt', async () => {
  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  const plan = await new NativeSweepPlanner(btcRpc()).plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const rpc = btcRpc({ count: 3 });
  await new NativeSweepPlanner(rpc).revalidate(request, plan.maxFeeUnits);
  assert.equal(rpc.calls.filter((c) => c.method === 'gettxout').length, 1);
  assert(!rpc.calls.some((c) => c.method === 'listunspent'));
  for (const [options, code] of [
    [{ spent: true }, 'waiting_resources'],
    [{ confirmations: 5 }, 'waiting_resources'],
    [{ coinbase: true, confirmations: 99 }, 'waiting_resources'],
    [{ rate: '0.00003' }, 'fee_budget'],
    [{ error: new RpcFailure() }, 'unavailable'],
  ] as const)
    await assert.rejects(
      new NativeSweepPlanner(btcRpc(options)).revalidate(request, plan.maxFeeUnits),
      expectDeferral(code),
    );
  await assert.rejects(
    new NativeSweepPlanner(btcRpc({ value: '0.00100001' })).revalidate(request, plan.maxFeeUnits),
    /outpoint amount/,
  );
  await assert.rejects(
    new NativeSweepPlanner(btcRpc({ foreign: true })).revalidate(request, plan.maxFeeUnits),
    /ownership/,
  );
  await assert.rejects(
    new NativeSweepPlanner(btcRpc()).revalidate(request, String(BigInt(plan.maxFeeUnits) - 1n)),
    expectDeferral('fee_budget'),
  );
});

test('Solana revalidation pins the original message and rejects changed rent, fees, validity and account state', async () => {
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  const plan = await new NativeSweepPlanner(solRpc()).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const rpc = solRpc();
  await new NativeSweepPlanner(rpc).revalidate(request, plan.maxFeeUnits);
  assert('recentBlockhash' in request.transaction);
  const expected = await nativeSolanaMessage(
    source.address,
    hot.address,
    request.transaction.recentBlockhash,
    BigInt(plan.amount),
  );
  assert.equal(
    rpc.calls.find((c) => c.method === 'getFeeForMessage')?.params[0],
    expected.toString('base64'),
  );
  assert.deepEqual(rpc.calls.find((c) => c.method === 'isBlockhashValid')?.params, [
    blockhash,
    { commitment: 'finalized', minContextSlot: 100 },
  ]);
  assert(!rpc.calls.some((c) => c.method === 'getLatestBlockhash'));
  for (const [options, code] of [
    [{ rent: 890881 }, 'waiting_funds'],
    [{ balance: 100 }, 'waiting_funds'],
    [{ fee: 5001 }, 'fee_budget'],
    [{ fee: null }, 'unavailable'],
    [{ feeContext: 99 }, 'unavailable'],
    [{ height: 1000 }, 'preparation_expired'],
    [{ blockhashValid: false }, 'preparation_expired'],
    [{ executable: true }, 'attention'],
    [{ owner: hot.address }, 'attention'],
    [{ data: 'AA==' }, 'attention'],
  ] as const)
    await assert.rejects(
      new NativeSweepPlanner(solRpc(options)).revalidate(request, plan.maxFeeUnits),
      expectDeferral(code),
    );
});

test('Ethereum observation verifies signed byte fields and recovers the source independently of provider assertions', async () => {
  const { rpc, input } = await ethereumObservation();
  assert('nonce' in input.request.transaction);
  const alteredRequest: SignRequest = {
    ...input.request,
    transaction: { ...input.request.transaction, nonce: '8' },
  };
  await assert.rejects(
    new NativeSweepPlanner(rpc).observe({ ...input, request: alteredRequest }),
    /exact signed request fields/,
  );
  const alteredSource: SignRequest = {
    ...input.request,
    wallet: { ...input.request.wallet, address: ethSource },
  };
  await assert.rejects(
    new NativeSweepPlanner(rpc).observe({ ...input, request: alteredSource }),
    /signed source/,
  );
});

test('Solana observation rejects forged source signatures before using RPC inclusion assertions', async () => {
  const source = wallet('solana', 10);
  const hot = wallet('solana', 0);
  const plan = await new NativeSweepPlanner(solRpc()).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  const request: SignRequest = { wallet: source, transaction: plan.request };
  const signed = signer.sign(request);
  const bytes = Buffer.from(signed.raw, 'base64');
  bytes[1] ^= 1;
  const core = await getWalletCore();
  const forged = {
    ...signed,
    raw: bytes.toString('base64'),
    txHash: core.Base58.encodeNoCheck(bytes.subarray(1, 65)),
  };
  await assert.rejects(
    new NativeSweepPlanner(solRpc()).observe({
      chain: 'solana',
      network: DEVNET,
      hash: forged.txHash,
      request,
      signed: forged,
    }),
    /source signature/,
  );
});

test('Native signed sweeps decode with independent EVM and Bitcoin tooling and verify Solana Ed25519 signatures', async () => {
  const { input } = await ethereumObservation();
  const eth = EvmTransaction.from(input.signed.raw);
  assert('amount' in input.request.transaction);
  const ethRequest = input.request.transaction;
  assert('gasLimit' in ethRequest);
  assert.equal(eth.from?.toLowerCase(), input.request.wallet.address);
  assert.equal(eth.to?.toLowerCase(), ethRequest.to);
  assert.equal(eth.value.toString(), ethRequest.amount);
  assert.equal(eth.gasLimit.toString(), ethRequest.gasLimit);
  assert.equal(eth.chainId.toString(), ethRequest.chainId);
  assert.equal(eth.nonce, Number(ethRequest.nonce));
  assert.equal(eth.maxFeePerGas?.toString(), ethRequest.maxFeePerGas);
  assert.equal(eth.data, '0x');

  const source = wallet('bitcoin', 10);
  const hot = wallet('bitcoin', 0);
  const plan = await new NativeSweepPlanner(btcRpc({ count: 2 })).plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: source.address,
    hotAddress: hot.address,
  });
  assert('utxos' in plan.request);
  const btc = BitcoinTransaction.fromHex(
    signer.sign({ wallet: source, transaction: plan.request }).raw,
  );
  assert.equal(btc.ins.length, 2);
  assert.equal(btc.outs.length, 1);
  assert.equal(btc.outs[0].value.toString(), plan.amount);
  assert.equal(
    Buffer.from(btc.outs[0].script).toString('hex'),
    '0014' + Buffer.from(regtestWitnessAddress(hot.address).program).toString('hex'),
  );
  const core = await getWalletCore();
  const p2pkh = Buffer.from(
    '76a914' + Buffer.from(regtestWitnessAddress(source.address).program).toString('hex') + '88ac',
    'hex',
  );
  for (let index = 0; index < btc.ins.length; index++) {
    const witness = btc.ins[index].witness;
    assert.equal(witness.length, 2);
    const publicKey = core.PublicKey.createWithData(witness[1], core.PublicKeyType.secp256k1);
    try {
      const signature = Buffer.from(witness[0]);
      const digest = btc.hashForWitnessV0(
        index,
        p2pkh,
        BigInt(plan.request.utxos[index].amount),
        signature[signature.length - 1],
      );
      assert(publicKey.verifyAsDER(signature.subarray(0, -1), digest));
    } finally {
      publicKey.delete();
    }
  }
  const solSource = wallet('solana', 10);
  const solHot = wallet('solana', 0);
  const solPlan = await new NativeSweepPlanner(solRpc()).plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: solSource.address,
    hotAddress: solHot.address,
  });
  const sol = Buffer.from(
    signer.sign({ wallet: solSource, transaction: solPlan.request }).raw,
    'base64',
  );
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(core.Base58.decodeNoCheck(solSource.address)),
    ]),
    format: 'der',
    type: 'spki',
  });
  assert(verify(null, sol.subarray(65), publicKey, sol.subarray(1, 65)));
  assert.equal(sol.subarray(-8).readBigUInt64LE().toString(), solPlan.amount);
});

test('Revalidation refuses an unavailable or switched RPC without creating a new preparation', async () => {
  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const) {
    const source =
      chain === 'ethereum'
        ? { chain, account: 10, seedId: 'sweep-test', address: ethSource, network: '11155111' }
        : wallet(chain, 10);
    const hotAddress = chain === 'ethereum' ? ethHot : wallet(chain, 0).address;
    const network = chain === 'ethereum' ? '11155111' : chain === 'bitcoin' ? 'regtest' : DEVNET;
    const healthy = chain === 'ethereum' ? ethRpc() : chain === 'bitcoin' ? btcRpc() : solRpc();
    const plan = await new NativeSweepPlanner(healthy).plan({
      chain,
      network,
      sourceAddress: source.address,
      hotAddress,
    });
    const request: SignRequest = { wallet: source, transaction: plan.request };
    const outage = new FakeRpc(() => {
      throw new RpcFailure();
    });
    await assert.rejects(
      new NativeSweepPlanner(outage).revalidate(request, plan.maxFeeUnits),
      expectDeferral('unavailable'),
    );
    const switched = new FakeRpc(() => {
      throw new Error('No balance RPC should run');
    });
    await assert.rejects(
      new NativeSweepPlanner(switched).revalidate(
        { ...request, wallet: { ...request.wallet, network: 'other' } },
        plan.maxFeeUnits,
      ),
      expectDeferral('attention'),
    );
    assert.equal(switched.calls.length, 0);
  }
});

test('native withdrawal plans preserve the accepted Ethereum amount and reserve only hot principal plus fees', async () => {
  const hot = signer.derive({ chain: 'ethereum', account: 0, seedId: 'sweep-test' });
  hot.address = hot.address.toLowerCase();
  const rpc = ethRpc();
  const planner = new NativeSweepPlanner(rpc);
  const plan = await planner.plan({
    chain: 'ethereum',
    network: '11155111',
    sourceAddress: hot.address,
    hotAddress: ethHot,
    amount: '1',
  });
  assert.equal(plan.amount, '1');
  const request = {
    wallet: {
      chain: hot.chain,
      seedId: hot.seedId,
      account: hot.account,
      address: hot.address,
      network: '11155111',
    },
    transaction: plan.request,
  };
  await planner.revalidate(request, plan.maxFeeUnits);
  const signed = signer.sign(request);
  const decoded = EvmTransaction.from(signed.raw);
  assert.equal(decoded.from?.toLowerCase(), hot.address);
  assert.equal(decoded.value, 1n);
  assert.equal(decoded.to?.toLowerCase(), ethHot);
  await assert.rejects(
    () =>
      new NativeSweepPlanner(ethRpc({ eth_getBalance: '0x1' })).plan({
        chain: 'ethereum',
        network: '11155111',
        sourceAddress: hot.address,
        hotAddress: ethHot,
        amount: '1',
      }),
    expectDeferral('waiting_funds'),
  );
});

test('Bitcoin native withdrawal signs exact principal and returns independently decoded change only to hot0', async () => {
  const hot = wallet('bitcoin', 0),
    destination = wallet('bitcoin', 11);
  const ownedScript =
    '0014' + Buffer.from(regtestWitnessAddress(hot.address).program).toString('hex');
  const rpc = new FakeRpc((method) => {
    if (method === 'listunspent')
      return [{ txid: '01'.repeat(32), vout: 0, address: hot.address, confirmations: 6 }];
    if (method === 'gettxout')
      return {
        value: '0.01000000',
        confirmations: 6,
        coinbase: false,
        scriptPubKey: { hex: ownedScript, address: hot.address },
      };
    if (method === 'estimatesmartfee') return { feerate: '0.00002' };
    throw new Error(`Unexpected ${method}`);
  });
  const planner = new NativeSweepPlanner(rpc);
  const plan = await planner.plan({
    chain: 'bitcoin',
    network: 'regtest',
    sourceAddress: hot.address,
    hotAddress: destination.address,
    amount: '50000',
  });
  assert.equal(plan.request.chain, 'bitcoin');
  if (plan.request.chain !== 'bitcoin') throw new Error();
  assert.equal(plan.amount, '50000');
  assert.equal(plan.request.sweepAll, undefined);
  assert.ok(BigInt(plan.request.changeAmount!) > 0n);
  const request = { wallet: hot, transaction: plan.request };
  await planner.revalidate(request, plan.maxFeeUnits);
  const signed = signer.sign(request);
  const decoded = BitcoinTransaction.fromHex(signed.raw);
  assert.equal(decoded.outs.length, 2);
  assert.equal(decoded.outs[0].value, 50000n);
  assert.equal(decoded.outs[1].value, BigInt(plan.request.changeAmount!));
  assert.equal(Buffer.from(decoded.outs[1].script).toString('hex'), ownedScript);
  assert.equal(
    1_000_000n - decoded.outs.reduce((sum, o) => sum + o.value, 0n),
    BigInt(plan.maxFeeUnits),
  );
  const included = new FakeRpc((method) => {
    if (method === 'getrawtransaction')
      return { txid: signed.txHash, hex: signed.raw, blockhash: btcBlock };
    if (method === 'getblockheader') return { hash: btcBlock, height: 10, confirmations: 6 };
    if (method === 'getblockhash') return btcBlock;
    throw new Error(`Unexpected ${method}`);
  });
  const observation = await new NativeSweepPlanner(included).observe({
    chain: 'bitcoin',
    network: 'regtest',
    hash: signed.txHash,
    request,
    signed,
  });
  assert.equal(observation.state, 'confirmed');
  assert.equal(observation.actualFeeUnits, plan.maxFeeUnits);
});

test('Solana native withdrawal keeps exact principal and hot rent instead of sweeping the balance', async () => {
  const hot = wallet('solana', 0),
    destination = wallet('solana', 11);
  const planner = new NativeSweepPlanner(solRpc());
  const plan = await planner.plan({
    chain: 'solana',
    network: DEVNET,
    sourceAddress: hot.address,
    hotAddress: destination.address,
    amount: '1000000',
  });
  assert.equal(plan.amount, '1000000');
  const request = { wallet: hot, transaction: plan.request };
  await planner.revalidate(request, plan.maxFeeUnits);
  const signed = signer.sign(request);
  assert.equal(signed.encoding, 'base64');
  const expected = await nativeSolanaMessage(hot.address, destination.address, blockhash, 1000000n);
  assert.deepEqual(Buffer.from(signed.raw, 'base64').subarray(65), expected);
  await assert.rejects(
    () =>
      new NativeSweepPlanner(solRpc({ balance: 1000 })).plan({
        chain: 'solana',
        network: DEVNET,
        sourceAddress: hot.address,
        hotAddress: destination.address,
        amount: '1000000',
      }),
    expectDeferral('insufficient_balance'),
  );
});
