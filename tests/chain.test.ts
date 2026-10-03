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

  assert.deepEqual(await rpc.observeTransaction('bitcoin', '01'.repeat(32)), { state: 'observed' });
  assert.deepEqual(calls, ['getblockchaininfo', 'getrawtransaction']);
});
