import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { chainNetworksFromEnv } from '../packages/chain/src/config.js';
import { SOLANA_DEVNET } from '../packages/shared/src/token-contracts.js';

// Read-only connectivity checks: no seed, signing, faucet requests or broadcasts.
async function main() {
  assert.equal(process.env.ETH_CHAIN_ID, '11155111', 'Expected Ethereum Sepolia');
  assert.equal(process.env.SOLANA_GENESIS_HASH, SOLANA_DEVNET, 'Expected Solana Devnet');
  assert(process.env.ETH_RPC_URL, 'Configure ETH_RPC_URL');
  assert(process.env.SOLANA_RPC_URL, 'Configure SOLANA_RPC_URL');
  const chainNetworks = chainNetworksFromEnv('11155111', SOLANA_DEVNET);
  assert.equal(chainNetworks.ethereum.network, '11155111');
  assert.equal(chainNetworks.solana.network, SOLANA_DEVNET);
  const rpc = new ChainRpcService({
    ethereumChainId: '11155111',
    solanaGenesisHash: SOLANA_DEVNET,
    chainNetworks,
  });
  const [ethereum, solana] = await Promise.all([
    (async () => {
      await rpc.verifyNetwork('ethereum');
      const block = (await rpc.call('ethereum', 'eth_getBlockByNumber', ['finalized', false])) as {
        number: string;
        hash: string;
        baseFeePerGas: string;
      };
      assert(block && /^0x[0-9a-f]+$/i.test(block.number));
      assert(/^0x[0-9a-f]{64}$/i.test(block.hash));
      assert(BigInt(block.baseFeePerGas) >= 0n);
      return { chainId: '11155111', finalizedBlock: BigInt(block.number).toString() };
    })(),
    (async () => {
      await rpc.verifyNetwork('solana');
      const block = (await rpc.call('solana', 'getLatestBlockhash', [
        { commitment: 'finalized' },
      ])) as {
        context: { slot: number };
        value: { blockhash: string; lastValidBlockHeight: number };
      };
      assert(Number.isSafeInteger(block.context.slot) && block.context.slot > 0);
      assert(block.value.blockhash && Number.isSafeInteger(block.value.lastValidBlockHeight));
      return { genesisHash: SOLANA_DEVNET, finalizedSlot: block.context.slot };
    })(),
  ]);
  let bitcoin;
  if (process.env.BTC_RPC_URL) {
    assert.equal(chainNetworks.bitcoin.network, 'testnet', 'Expected Bitcoin Testnet3');
    await rpc.verifyNetwork('bitcoin');
    const info = (await rpc.call('bitcoin', 'getblockchaininfo', [])) as {
      chain: string;
      blocks: number;
      initialblockdownload: boolean;
    };
    assert.equal(info.chain, 'test');
    assert.equal(info.initialblockdownload, false);
    assert(Number.isSafeInteger(info.blocks) && info.blocks > 0);
    bitcoin = { network: 'testnet', rpcChain: info.chain, blocks: info.blocks };
  }
  console.log(
    JSON.stringify({ checkedAt: new Date().toISOString(), ethereum, solana, bitcoin }, null, 2),
  );
}

main().catch(() => {
  // RPC URLs can contain provider credentials; do not print raw transport errors.
  console.error('Testnet RPC check failed; verify Sepolia/Devnet settings and RPC availability');
  process.exitCode = 1;
});
