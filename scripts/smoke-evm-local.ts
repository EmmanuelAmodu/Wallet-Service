import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transaction } from 'ethers';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import { SignRequest } from '../packages/shared/src/contracts.js';

// This runner owns its ephemeral Anvil process. It accepts no remote RPC URL or real seed.
export async function smokeEvmLocal() {
  const evidenceFolder = resolve('artifacts', 'acceptance', 'evm-local');
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
  const node = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111', '--silent'],
    { stdio: 'ignore' },
  );
  const exited = once(node, 'exit').catch(() => undefined);
  let spawnError: unknown;
  node.on('error', (error) => {
    spawnError = error;
  });
  const rpc = new ChainRpcService({
    ethereumChainId: '11155111',
    ethereumUrl: `http://127.0.0.1:${port}`,
    solanaGenesisHash: 'unused',
  });
  let core: SigningCore | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError || node.exitCode !== null) throw new Error('Local Anvil unavailable');
      try {
        await rpc.verifyNetwork('ethereum');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Local Anvil did not start');
    core = await SigningCore.create(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'acceptance-only',
      '11155111',
    );
    const source = core.derive({ chain: 'ethereum', seedId: 'acceptance-only', account: 10 });
    const hot = core.derive({ chain: 'ethereum', seedId: 'acceptance-only', account: 0 });
    const recipient = core.derive({ chain: 'ethereum', seedId: 'acceptance-only', account: 11 });
    const original = 1_000_000_000_000_000_000n;
    await rpc.call('ethereum', 'anvil_setBalance', [source.address, `0x${original.toString(16)}`]);
    await rpc.call('ethereum', 'anvil_setBalance', [hot.address, '0x0']);
    await rpc.call('ethereum', 'anvil_setBalance', [recipient.address, '0x0']);
    const planner = new NativeSweepPlanner(rpc),
      evidence = [];
    for (const [purpose, from, to, amount] of [
      ['customer-sweep', source, hot, undefined],
      ['hot-withdrawal', hot, recipient, '1000000000000000'],
    ] as const) {
      const plan = await planner.plan({
        chain: 'ethereum',
        network: '11155111',
        sourceAddress: from.address.toLowerCase(),
        hotAddress: to.address.toLowerCase(),
        ...(amount ? { amount } : {}),
      });
      const request: SignRequest = {
        wallet: {
          chain: 'ethereum',
          seedId: from.seedId,
          account: from.account,
          address: from.address.toLowerCase(),
          network: '11155111',
        },
        transaction: plan.request,
      };
      const signed = core.sign(request),
        decoded = Transaction.from(signed.raw);
      assert.equal(decoded.from!.toLowerCase(), from.address.toLowerCase());
      assert.equal(decoded.to!.toLowerCase(), to.address.toLowerCase());
      assert.equal(decoded.chainId, 11155111n);
      assert.equal(decoded.value.toString(), plan.amount);
      assert.equal(decoded.data, '0x');
      assert.ok(decoded.gasLimit >= 21000n && decoded.gasLimit <= 25200n);
      await planner.revalidate(request, plan.maxFeeUnits);
      const before = BigInt(
        (await rpc.call('ethereum', 'eth_getBalance', [to.address, 'latest'])) as string,
      );
      assert.equal(
        await rpc.call('ethereum', 'eth_sendRawTransaction', [signed.raw]),
        signed.txHash,
      );
      await rpc.call('ethereum', 'anvil_mine', [64]);
      const receipt = (await rpc.call('ethereum', 'eth_getTransactionReceipt', [
        signed.txHash,
      ])) as { status: string; gasUsed: string; effectiveGasPrice: string; blockHash: string };
      assert.equal(receipt.status, '0x1');
      assert.equal(BigInt(receipt.gasUsed), 21000n);
      const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      assert.ok(fee <= BigInt(plan.maxFeeUnits));
      assert.equal(
        BigInt((await rpc.call('ethereum', 'eth_getBalance', [to.address, 'latest'])) as string) -
          before,
        BigInt(plan.amount),
      );
      const observation = await planner.observe({
        chain: 'ethereum',
        network: '11155111',
        hash: signed.txHash,
        request,
        signed,
      });
      assert.equal(observation.state, 'confirmed');
      assert.equal(observation.actualFeeUnits, fee.toString());
      evidence.push({
        purpose,
        hash: signed.txHash,
        from: from.address,
        to: to.address,
        principalUnits: plan.amount,
        maximumFeeUnits: plan.maxFeeUnits,
        actualFeeUnits: fee.toString(),
        blockHash: receipt.blockHash,
        resourceKeys: plan.resourceKeys,
      });
    }
    const folder = resolve('artifacts', 'acceptance', 'evm-local');
    await mkdir(folder, { recursive: true });
    await writeFile(
      resolve(folder, 'result.json'),
      JSON.stringify(
        {
          status: 'passed',
          verifiedAt: new Date().toISOString(),
          scope:
            'ephemeral Anvil with Sepolia chain ID; real Wallet Core signatures and canonical native execution; not public Sepolia/provider or token certification',
          evidence,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Local EVM smoke passed: ${folder}`);
  } finally {
    core?.close();
    if (node.exitCode === null && !spawnError) {
      node.kill('SIGTERM');
      await exited;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  smokeEvmLocal().catch(() => {
    console.error('Local EVM smoke failed; no live RPC or funds were used.');
    process.exitCode = 1;
  });
