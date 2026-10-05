import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ChainRpcService, NetworkConfig } from '../packages/chain/src/chain-rpc.service.js';
import { Transfer } from '../packages/shared/src/contracts.js';

async function rpcServer(t: TestContext, methods: string[], respond: (method: string) => unknown) {
  const server: Server = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const { id, method } = JSON.parse(input) as { id: string; method: string };
    methods.push(method);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: respond(method) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('EVM and Bitcoin-family preparation use the configured chain RPC', async (t) => {
  const fallbackCalls: string[] = [];
  const customCalls: string[] = [];
  const fallbackUrl = await rpcServer(t, fallbackCalls, (method) => {
    if (method === 'eth_chainId') return '0x1';
    throw new Error(`Unexpected fallback RPC call: ${method}`);
  });
  const address = '0x' + '11'.repeat(20);
  const customUrl = await rpcServer(t, customCalls, (method) => {
    switch (method) {
      case 'eth_chainId':
        return '0x89';
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_getBalance':
        return '0xffffffffffffffff';
      case 'getblockchaininfo':
        return { chain: 'main' };
      case 'gettxout':
        return {
          value: 1,
          confirmations: 2,
          coinbase: false,
          scriptPubKey: { hex: '0014' + '22'.repeat(20), address },
        };
      default:
        throw new Error(`Unexpected custom RPC call: ${method}`);
    }
  });
  const config: NetworkConfig = {
    ethereumUrl: fallbackUrl,
    ethereumChainId: '1',
    bitcoinUrl: fallbackUrl,
    solanaGenesisHash: 'devnet',
    chainNetworks: {
      polygon: { network: '137', chainId: '137', rpcUrl: customUrl },
      litecoin: { network: 'mainnet', rpcNetwork: 'main', rpcUrl: customUrl },
    },
  };
  const rpc = new ChainRpcService(config);

  const evmTransfer: Transfer = {
    chain: 'polygon',
    to: '0x' + '33'.repeat(20),
    amount: '1',
    maxFeePerGas: '2',
    maxPriorityFeePerGas: '1',
  };
  const preparedEvm = await rpc.prepare(address, evmTransfer);
  assert.equal(preparedEvm.chain, 'polygon');
  assert.deepEqual(customCalls.slice(0, 4), [
    'eth_chainId',
    'eth_getTransactionCount',
    'eth_estimateGas',
    'eth_getBalance',
  ]);
  assert.deepEqual(fallbackCalls, []);

  const bitcoinTransfer: Transfer = {
    chain: 'litecoin',
    outputs: [{ address, amount: '1' }],
    utxos: [{ txid: '01'.repeat(32), vout: 0 }],
    satsPerVbyte: 1,
  };
  const preparedBitcoin = await rpc.prepare(address, bitcoinTransfer);
  assert.equal(preparedBitcoin.chain, 'litecoin');
  assert.deepEqual(customCalls.slice(4), ['getblockchaininfo', 'gettxout']);
  assert.deepEqual(fallbackCalls, []);
});

test('RPC network identity is checked for EVM, Bitcoin, and Solana', async (t) => {
  const calls: string[] = [];
  let mismatch = false;
  const url = await rpcServer(t, calls, (method) => {
    switch (method) {
      case 'eth_chainId':
        return mismatch ? '0x1' : '0xaa36a7';
      case 'getblockchaininfo':
        return { chain: mismatch ? 'regtest' : 'main' };
      case 'getGenesisHash':
        return mismatch ? 'wrong-genesis' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      default:
        throw new Error(`Unexpected RPC method: ${method}`);
    }
  });
  const rpc = new ChainRpcService({
    ethereumUrl: url,
    ethereumChainId: '11155111',
    bitcoinUrl: url,
    solanaUrl: url,
    solanaGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  });

  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const) await rpc.verifyNetwork(chain);
  assert.deepEqual(calls, ['eth_chainId', 'getblockchaininfo', 'getGenesisHash']);

  mismatch = true;
  for (const chain of ['ethereum', 'bitcoin', 'solana'] as const)
    await assert.rejects(rpc.verifyNetwork(chain), /network mismatch/);
});

test('Bitcoin mempool transactions without confirmations are observed', async (t) => {
  const calls: string[] = [];
  const url = await rpcServer(t, calls, (method) => {
    if (method === 'getblockchaininfo') return { chain: 'main' };
    if (method === 'getrawtransaction') return { txid: '01'.repeat(32) };
    throw new Error(`Unexpected RPC method: ${method}`);
  });
  const rpc = new ChainRpcService({
    ethereumChainId: '1',
    bitcoinUrl: url,
    solanaGenesisHash: 'devnet',
  });

  assert.deepEqual(await rpc.observeTransaction('bitcoin', '01'.repeat(32)), {
    state: 'observed',
    transactionFound: true,
  });
  assert.deepEqual(calls, ['getblockchaininfo', 'getrawtransaction']);
});

test('EVM receipt absence distinguishes pending transactions from transactions no longer found', async (t) => {
  const calls: string[] = [];
  const url = await rpcServer(t, calls, (method) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_getTransactionByHash') return null;
    throw new Error(`Unexpected RPC method: ${method}`);
  });
  const rpc = new ChainRpcService({
    ethereumUrl: url,
    ethereumChainId: '1',
    solanaGenesisHash: 'devnet',
  });

  assert.deepEqual(await rpc.observeTransaction('ethereum', '0xabc'), {
    state: 'observed',
    transactionFound: false,
  });
  assert.deepEqual(calls, ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
});

test('Bitcoin regtest preparation verifies its node and rejects mainnet recipients before loading UTXOs', async (t) => {
  const calls: string[] = [];
  let wrongNetwork = false;
  const address = 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk';
  const script = '0014d0c4a3ef09e997b6e99e397e518fe3e41a118ca1';
  const url = await rpcServer(t, calls, (method) => {
    if (method === 'getblockchaininfo') return { chain: wrongNetwork ? 'main' : 'regtest' };
    if (method === 'gettxout')
      return {
        value: 0.001,
        confirmations: 6,
        coinbase: false,
        scriptPubKey: { hex: script, address },
      };
    throw new Error('Unexpected RPC method');
  });
  const rpc = new ChainRpcService({
    ethereumChainId: '11155111',
    solanaGenesisHash: 'devnet',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest', rpcUrl: url } },
  });
  const transfer: Transfer = {
    chain: 'bitcoin',
    outputs: [{ address, amount: '10000' }],
    utxos: [{ txid: '02'.repeat(32), vout: 0 }],
    satsPerVbyte: 2,
  };
  assert.equal(rpc.networkIdentity('bitcoin'), 'regtest');
  const prepared = await rpc.prepare(address, transfer);
  assert.ok('utxos' in prepared);
  assert.equal(prepared.utxos[0].amount, '100000');
  assert.equal(prepared.utxos[0].script, script);
  assert.deepEqual(calls, ['getblockchaininfo', 'gettxout']);
  await assert.rejects(
    rpc.prepare(address, {
      ...transfer,
      outputs: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: '10000' }],
    }),
    /regtest/,
  );
  assert.equal(calls.filter((method) => method === 'gettxout').length, 1);
  wrongNetwork = true;
  await assert.rejects(rpc.prepare(address, transfer), /network mismatch/);
  assert.equal(calls.filter((method) => method === 'gettxout').length, 1);
});
