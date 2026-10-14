import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getWalletCore } from '../packages/chain/src/coin-metadata.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import { SignRequest } from '../packages/shared/src/contracts.js';
import { SOLANA_DEVNET } from '../packages/shared/src/token-contracts.js';

// Explicit testnet-only runner: random in-memory seed, faucet funds, pinned Devnet genesis.
// Never reads the application seed, databases, rollout flags or private provider credentials.
export async function smokeSolanaDevnet() {
  const evidenceFolder = resolve('artifacts', 'acceptance', 'solana-devnet');
  await mkdir(evidenceFolder, { recursive: true });
  await writeFile(
    resolve(evidenceFolder, 'result.json'),
    JSON.stringify({ status: 'not-passed', startedAt: new Date().toISOString() }) + '\n',
  );
  const rpc = new ChainRpcService({
    ethereumChainId: 'unused',
    solanaGenesisHash: SOLANA_DEVNET,
    solanaUrl: 'https://api.devnet.solana.com',
  });
  await rpc.verifyNetwork('solana');
  const walletCore = await getWalletCore(),
    wallet = walletCore.HDWallet.create(128, '');
  let core: SigningCore;
  try {
    core = await SigningCore.create(wallet.mnemonic(), 'acceptance-only', '11155111', undefined, {
      domainId: 'acceptance-only',
      chainNetworks: { solana: { network: SOLANA_DEVNET, genesisHash: SOLANA_DEVNET } },
    });
  } finally {
    wallet.delete();
  }
  const folder = resolve('artifacts', 'acceptance', 'solana-devnet');
  await mkdir(folder, { recursive: true });
  const evidence: unknown[] = [];
  let stage = 'faucet';
  try {
    const source = core.derive({ chain: 'solana', seedId: 'acceptance-only', account: 10 }),
      hot = core.derive({ chain: 'solana', seedId: 'acceptance-only', account: 0 }),
      recipient = core.derive({ chain: 'solana', seedId: 'acceptance-only', account: 11 });
    const airdrop = await rpc.call('solana', 'requestAirdrop', [source.address, 100000000]);
    stage = 'faucet-finality';
    let funded = false;
    for (let i = 0; i < 90; i++) {
      const status = (await rpc.call('solana', 'getSignatureStatuses', [
        [airdrop],
        { searchTransactionHistory: true },
      ])) as { value: ({ confirmationStatus: string; err: unknown } | null)[] };
      if (status.value[0]?.confirmationStatus === 'finalized') {
        assert.equal(status.value[0].err, null);
        funded = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!funded) throw new Error('Devnet faucet finality unavailable');
    const planner = new NativeSweepPlanner(rpc);
    for (const [purpose, from, to, amount] of [
      ['customer-sweep', source, hot, undefined],
      ['hot-withdrawal', hot, recipient, '2000000'],
    ] as const) {
      stage = 'planning';
      const plan = await planner.plan({
        chain: 'solana',
        network: SOLANA_DEVNET,
        sourceAddress: from.address,
        hotAddress: to.address,
        ...(amount ? { amount } : {}),
      });
      const request: SignRequest = {
        wallet: {
          chain: 'solana',
          seedId: from.seedId,
          account: from.account,
          address: from.address,
          network: SOLANA_DEVNET,
        },
        transaction: plan.request,
      };
      const signed = core.sign(request);
      await planner.revalidate(request, plan.maxFeeUnits);
      stage = 'simulation';
      const simulation = (await rpc.call('solana', 'simulateTransaction', [
        signed.raw,
        { encoding: 'base64', sigVerify: true, commitment: 'finalized' },
      ])) as { value: { err: unknown } };
      assert.equal(simulation.value.err, null);
      stage = 'submission';
      assert.equal(
        await rpc.call('solana', 'sendTransaction', [
          signed.raw,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'finalized',
            maxRetries: 0,
          },
        ]),
        signed.txHash,
      );
      stage = 'canonical-finality';
      let confirmed = false;
      for (let i = 0; i < 90; i++) {
        const observation = await planner.observe({
          chain: 'solana',
          network: SOLANA_DEVNET,
          hash: signed.txHash,
          request,
          signed,
        });
        if (observation.state === 'confirmed') {
          assert.ok(BigInt(observation.actualFeeUnits!) <= BigInt(plan.maxFeeUnits));
          evidence.push({
            purpose,
            hash: signed.txHash,
            from: from.address,
            to: to.address,
            principalUnits: plan.amount,
            maximumFeeUnits: plan.maxFeeUnits,
            ...observation,
            resourceKeys: plan.resourceKeys,
          });
          confirmed = true;
          break;
        }
        if (observation.state === 'failed' || observation.state === 'reverted')
          throw new Error('Devnet signed execution failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!confirmed)
        throw new Error(
          'Devnet inclusion/finality unavailable; no replacement or resend attempted',
        );
    }
    await writeFile(
      resolve(folder, 'result.json'),
      JSON.stringify(
        {
          status: 'passed',
          verifiedAt: new Date().toISOString(),
          scope:
            'random ephemeral seed and faucet-funded native Solana Devnet transfers; not SPL or provider certification',
          evidence,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Solana Devnet smoke passed: ${folder}`);
  } catch (error) {
    await writeFile(
      resolve(folder, 'result.json'),
      JSON.stringify(
        {
          status: 'not-passed',
          stage,
          rpcCode: error instanceof RpcFailure ? (error.rpcCode ?? null) : null,
          verifiedAt: new Date().toISOString(),
          scope: 'Solana Devnet smoke requires available public RPC/faucet/finality',
          evidence,
        },
        null,
        2,
      ) + '\n',
    );
    throw new Error(
      'Solana Devnet smoke not passed; inspect testnet RPC/faucet availability and retained public evidence',
      { cause: error },
    );
  } finally {
    core.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--run')) {
    console.error('Pass --run to request Devnet faucet funds and submit two testnet transfers.');
    process.exitCode = 1;
  } else
    smokeSolanaDevnet().catch(() => {
      console.error('Solana Devnet smoke not passed. No application seed or real funds were used.');
      process.exitCode = 1;
    });
}
