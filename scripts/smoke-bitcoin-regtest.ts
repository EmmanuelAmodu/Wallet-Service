import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import { SignRequest } from '../packages/shared/src/contracts.js';

export async function smokeBitcoinRegtest() {
  const evidenceFolder = resolve('artifacts', 'acceptance', 'bitcoin-regtest');
  await mkdir(evidenceFolder, { recursive: true });
  await writeFile(
    resolve(evidenceFolder, 'result.json'),
    JSON.stringify({ status: 'not-passed', startedAt: new Date().toISOString() }) + '\n',
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const directory = await mkdtemp(join(tmpdir(), 'waas-bitcoin-smoke-'));
  const node = spawn(
    process.env.BITCOIND_PATH ?? 'bitcoind',
    [
      '-regtest',
      '-server',
      '-listen=0',
      '-connect=0',
      '-dnsseed=0',
      '-discover=0',
      '-txindex=1',
      `-datadir=${directory}`,
      `-rpcport=${port}`,
      '-rpcbind=127.0.0.1',
      '-rpcuser=smoke-only',
      '-rpcpassword=smoke-only',
    ],
    { stdio: 'ignore' },
  );
  const exited = once(node, 'exit').catch(() => undefined);
  let spawnError: unknown;
  node.on('error', (e) => {
    spawnError = e;
  });
  const settings = {
    network: 'regtest',
    rpcNetwork: 'regtest',
    rpcUrl: `http://127.0.0.1:${port}`,
    rpcUser: 'smoke-only',
    rpcPassword: 'smoke-only',
  };
  const root = new ChainRpcService({
    ethereumChainId: 'unused',
    solanaGenesisHash: 'unused',
    chainNetworks: { bitcoin: settings },
  });
  let core: SigningCore | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (spawnError || node.exitCode !== null) throw new Error('Local Bitcoin Core unavailable');
      try {
        await root.verifyNetwork('bitcoin');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Regtest node did not start');
    await root.call('bitcoin', 'createwallet', ['smoke', true, true, '', false, true]);
    const rpc = new ChainRpcService({
      ethereumChainId: 'unused',
      solanaGenesisHash: 'unused',
      chainNetworks: { bitcoin: { ...settings, rpcUrl: settings.rpcUrl + '/wallet/smoke' } },
    });
    core = await SigningCore.create(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'acceptance-only',
      '11155111',
      undefined,
      {
        domainId: 'acceptance-only',
        chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
      },
    );
    const source = core.derive({ chain: 'bitcoin', seedId: 'acceptance-only', account: 10 }),
      hot = core.derive({ chain: 'bitcoin', seedId: 'acceptance-only', account: 0 }),
      recipient = core.derive({ chain: 'bitcoin', seedId: 'acceptance-only', account: 11 }),
      miner = core.derive({ chain: 'bitcoin', seedId: 'acceptance-only', account: 12 });
    for (const wallet of [source, hot, recipient]) {
      const desc = (await rpc.call('bitcoin', 'getdescriptorinfo', [
        `addr(${wallet.address})`,
      ])) as { descriptor: string };
      const imported = (await rpc.call('bitcoin', 'importdescriptors', [
        [{ desc: desc.descriptor, timestamp: 0 }],
      ])) as { success: boolean }[];
      assert.equal(imported[0].success, true);
    }
    await rpc.call('bitcoin', 'generatetoaddress', [101, source.address]);
    const planner = new NativeSweepPlanner(rpc),
      evidence = [];
    for (const [purpose, from, to, amount] of [
      ['customer-sweep', source, hot, undefined],
      ['hot-withdrawal', hot, recipient, '100000000'],
    ] as const) {
      const plan = await planner.plan({
        chain: 'bitcoin',
        network: 'regtest',
        sourceAddress: from.address,
        hotAddress: to.address,
        ...(amount ? { amount } : {}),
      });
      const request: SignRequest = {
        wallet: {
          chain: 'bitcoin',
          seedId: from.seedId,
          account: from.account,
          address: from.address,
          network: 'regtest',
        },
        transaction: plan.request,
      };
      const signed = core.sign(request);
      await planner.revalidate(request, plan.maxFeeUnits);
      const decoded = (await rpc.call('bitcoin', 'decoderawtransaction', [signed.raw])) as {
        txid: string;
        vin: unknown[];
        vout: { value: number; scriptPubKey: { address: string } }[];
      };
      assert.equal(decoded.txid, signed.txHash);
      assert.equal(decoded.vout[0].scriptPubKey.address, to.address);
      assert.equal(BigInt(decoded.vout[0].value.toFixed(8).replace('.', '')), BigInt(plan.amount));
      const expectedInputs = plan.request.chain === 'bitcoin' ? plan.request.utxos.length : 0;
      assert.equal(decoded.vin.length, expectedInputs);
      const admitted = (await rpc.call('bitcoin', 'testmempoolaccept', [[signed.raw]])) as {
        allowed: boolean;
      }[];
      assert.equal(admitted[0].allowed, true);
      assert.equal(await rpc.call('bitcoin', 'sendrawtransaction', [signed.raw]), signed.txHash);
      await rpc.call('bitcoin', 'generatetoaddress', [6, miner.address]);
      const observation = await planner.observe({
        chain: 'bitcoin',
        network: 'regtest',
        hash: signed.txHash,
        request,
        signed,
      });
      assert.equal(observation.state, 'confirmed');
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
    }
    const folder = resolve('artifacts', 'acceptance', 'bitcoin-regtest');
    await mkdir(folder, { recursive: true });
    await writeFile(
      resolve(folder, 'result.json'),
      JSON.stringify(
        {
          status: 'passed',
          verifiedAt: new Date().toISOString(),
          scope:
            'disposable Bitcoin Core regtest; real Wallet Core signatures, mempool validation, recipients, inputs, fees and six-block canonical finality; not public Bitcoin deployment',
          evidence,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Bitcoin regtest smoke passed: ${folder}`);
  } finally {
    core?.close();
    if (node.exitCode === null && !spawnError) {
      node.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  smokeBitcoinRegtest().catch(() => {
    console.error('Bitcoin regtest smoke failed; no live RPC or funds were used.');
    process.exitCode = 1;
  });
