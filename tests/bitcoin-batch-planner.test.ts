import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Transaction } from 'bitcoinjs-lib';
import { BitcoinBatchPlanner } from '../packages/chain/src/bitcoin-batch-planner.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { regtestWitnessAddress } from '../packages/chain/src/bitcoin-address.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { payoutBatchManifestSchema } from '../packages/shared/src/payout-policy.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import { Chain } from '../packages/shared/src/contracts.js';

let core: SigningCore;
before(async () => {
  core = await SigningCore.create(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    'batch-test',
    '11155111',
    undefined,
    {
      domainId: 'exchange',
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    },
  );
});
after(() => core.close());

function manifest() {
  const hot = core.derive({ chain: 'bitcoin', seedId: 'batch-test', account: 0 });
  const recipient = core.derive({ chain: 'bitcoin', seedId: 'batch-test', account: 10 });
  return payoutBatchManifestSchema.parse({
    version: 1,
    batchId: randomUUID(),
    domainId: 'exchange',
    resetEpoch: 'epoch',
    seedId: 'batch-test',
    sourceWalletId: randomUUID(),
    sourceRegistryRevision: 1,
    sourceAddress: hot.address,
    asset: { chain: 'bitcoin', network: 'regtest', assetId: 'token:bitcoin:native' },
    feeAllocation: 'equal-largest-remainder-v1',
    members: Array.from({ length: 3 }, () => ({
      operationId: randomUUID(),
      attemptId: randomUUID(),
      reservationId: randomUUID(),
      customerId: randomUUID(),
      requestDigest: 'a'.repeat(64),
      destination: recipient.address,
      principalUnits: '1000',
      maximumFeeUnits: '10000',
      maximumRentUnits: '0',
    })).sort((a, b) => a.operationId.localeCompare(b.operationId)),
  });
}

class Rpc extends ChainRpcService {
  calls: string[] = [];
  constructor(
    readonly source: string,
    readonly options: { value?: string; spent?: boolean; foreign?: boolean; rate?: string } = {},
  ) {
    super({
      ethereumChainId: '11155111',
      solanaGenesisHash: 'unused',
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
  }

  override async call(_chain: Chain, method: string, _params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    if (method === 'listunspent')
      return [{ txid: 'a'.repeat(64), vout: 2, address: this.source, confirmations: 6 }];
    if (method === 'gettxout')
      return this.options.spent
        ? null
        : {
            value: this.options.value ?? '0.001',
            confirmations: 6,
            coinbase: false,
            scriptPubKey: {
              hex:
                '0014' +
                (this.options.foreign
                  ? 'ff'.repeat(20)
                  : Buffer.from(regtestWitnessAddress(this.source).program).toString('hex')),
              address: this.source,
            },
          };
    if (method === 'estimatesmartfee') return { feerate: this.options.rate ?? '0.00002' };
    throw new Error(`Unexpected RPC ${method}`);
  }
}

test('Bitcoin batch preparation conserves inputs/principal/fee/change with separate outputs for repeated recipients', async () => {
  const m = manifest(),
    rpc = new Rpc(m.sourceAddress);
  const plan = await new BitcoinBatchPlanner(rpc).plan(m);
  assert.equal(plan.principalUnits, '3000');
  assert.equal(
    BigInt(plan.principalUnits) + BigInt(plan.feeUnits) + BigInt(plan.changeUnits),
    100000n,
  );
  assert.equal(
    plan.memberCosts.reduce((sum, c) => sum + BigInt(c.feeUnits), 0n),
    BigInt(plan.feeUnits),
  );
  assert.deepEqual(
    plan.memberOutputs.map((m) => m.outputIndex),
    [0, 2, 3],
  );
  assert.deepEqual(plan.resourceKeys, ['utxo:' + 'a'.repeat(64) + ':2']);
  assert.equal(plan.requestDigest, executionDigest(plan.request));
  const { preparationDigest, ...body } = plan;
  assert.equal(preparationDigest, executionDigest(body));
  const signed = core.sign(plan.request),
    decoded = Transaction.fromHex(signed.raw);
  assert.equal(decoded.outs.length, 4);
  assert.equal(decoded.outs[1].value, BigInt(plan.changeUnits));
  for (const member of plan.memberOutputs)
    assert.equal(decoded.outs[member.outputIndex].value, 1000n);
  assert(plan.request.transaction.chain === 'bitcoin');
  assert(
    BigInt(plan.feeUnits) >= BigInt(decoded.virtualSize() * plan.request.transaction.satsPerVbyte),
  );
  assert(!rpc.calls.some((m) => /send|sign|lockunspent/.test(m)));
});

test('Bitcoin batch preparation refuses insufficient change, exhausted member budgets and foreign/spent inputs', async () => {
  const m = manifest();
  for (const options of [
    { value: '0.000036' },
    { spent: true },
    { foreign: true },
    { rate: '0.001' },
  ])
    await assert.rejects(new BitcoinBatchPlanner(new Rpc(m.sourceAddress, options)).plan(m));
  const bounded = structuredClone(m);
  bounded.members[0].maximumFeeUnits = '0';
  await assert.rejects(
    new BitcoinBatchPlanner(new Rpc(m.sourceAddress)).plan(bounded),
    /member fee budget/,
  );
});

test('Bitcoin batch preparation validates canonical recipients before consulting RPC', async () => {
  const m = manifest(),
    rpc = new Rpc(m.sourceAddress);
  m.members[1].destination = 'bcrt1q' + 'z'.repeat(38);
  await assert.rejects(new BitcoinBatchPlanner(rpc).plan(m));
  assert.equal(rpc.calls.length, 0);
});
