import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chainNetworkOverridesFromEnv } from '../packages/chain/src/config.js';
import { bitcoinWitnessAddress } from '../packages/chain/src/bitcoin-address.js';
import { canonicalizeDerivedAddress } from '../packages/chain/src/coin-metadata.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { verifyBitcoinPayment } from '../packages/chain/src/native-sweep-planner.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { canonicalWithdrawalDestination } from '../apps/wallet/src/withdrawals/withdrawals.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { MessageAuth } from '../packages/queue/src/messages.js';
import { SignRequest } from '../packages/shared/src/contracts.js';
import { custodySettings, isolatedDatabase, testMnemonic } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';

const genesis = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';

test('Testnet3 config binds the explicit testnet address network to Core chain test', (t) => {
  const previous = process.env.CHAIN_NETWORKS;
  t.after(() => {
    if (previous === undefined) delete process.env.CHAIN_NETWORKS;
    else process.env.CHAIN_NETWORKS = previous;
  });
  process.env.CHAIN_NETWORKS = JSON.stringify({ bitcoin: { network: 'testnet' } });
  assert.equal(chainNetworkOverridesFromEnv().bitcoin.rpcNetwork, 'test');
  for (const rpcNetwork of ['main', 'regtest', 'testnet4']) {
    process.env.CHAIN_NETWORKS = JSON.stringify({ bitcoin: { network: 'testnet', rpcNetwork } });
    assert.throws(() => chainNetworkOverridesFromEnv(), /does not match/);
  }
});

test('Testnet3 derivation, exact transfer signing and change use tb addresses and coin type 1', async () => {
  const core = await SigningCore.create(testMnemonic, 'testnet-fixture', '11155111', undefined, {
    domainId: 'testnet-fixture',
    chainNetworks: { bitcoin: { network: 'testnet', rpcNetwork: 'test' } },
  });
  try {
    const source = core.derive({ chain: 'bitcoin', seedId: 'testnet-fixture', account: 0 });
    const recipient = core.derive({ chain: 'bitcoin', seedId: 'testnet-fixture', account: 10 });
    assert.equal(source.path, "m/84'/1'/0'/0/0");
    assert(source.address.startsWith('tb1q'));
    assert.equal(recipient.path, "m/84'/1'/10'/0/0");
    assert.equal(
      await canonicalizeDerivedAddress('bitcoin', 'testnet', source.address),
      source.address,
    );
    assert.equal(
      await canonicalWithdrawalDestination('bitcoin', recipient.address, 'testnet'),
      recipient.address,
    );
    const request: SignRequest = {
      wallet: {
        chain: 'bitcoin',
        seedId: source.seedId,
        account: 0,
        network: 'testnet',
        address: source.address,
      },
      transaction: {
        chain: 'bitcoin',
        satsPerVbyte: 1,
        changeAmount: '97000',
        outputs: [{ address: recipient.address, amount: '2000' }],
        utxos: [
          {
            txid: 'a'.repeat(64),
            vout: 0,
            amount: '100000',
            script:
              '0014' +
              Buffer.from(bitcoinWitnessAddress(source.address, 'testnet').program).toString('hex'),
          },
        ],
      },
    };
    const signed = core.sign(request);
    assert.equal(verifyBitcoinPayment(request, signed).feeUnits, '1000');
    assert.throws(
      () => core.sign({ ...request, wallet: { ...request.wallet, network: undefined } }),
      /network/,
    );
    assert.throws(
      () => core.sign({ ...request, wallet: { ...request.wallet, network: 'regtest' } }),
      /network/,
    );
    assert.throws(() => bitcoinWitnessAddress(source.address, 'regtest'));
    await assert.rejects(canonicalWithdrawalDestination('bitcoin', recipient.address, 'regtest'));
    const changed = structuredClone(request);
    if (changed.transaction.chain !== 'bitcoin') throw new Error('fixture');
    changed.transaction.outputs[0].amount = '2001';
    assert.throws(() => verifyBitcoinPayment(changed, signed), /payout/);
  } finally {
    core.close();
  }
});

test('Testnet3 RPC verification rejects mainnet, regtest, Testnet4 and a forged chain-name match', async () => {
  let chain = 'test',
    hash = genesis;
  const rpc = new (class extends ChainRpcService {
    override async call(_chain: unknown, method: string): Promise<unknown> {
      if (method === 'getblockchaininfo') return { chain };
      if (method === 'getblockhash') return hash;
      throw new Error('Unexpected method');
    }
  })({
    ethereumChainId: '11155111',
    solanaGenesisHash: 'unused',
    chainNetworks: { bitcoin: { network: 'testnet', rpcNetwork: 'test' } },
  });
  await rpc.verifyNetwork('bitcoin');
  for (chain of ['main', 'regtest', 'testnet4'])
    await assert.rejects(rpc.verifyNetwork('bitcoin'), /network mismatch/);
  chain = 'test';
  hash = '0'.repeat(64);
  await assert.rejects(rpc.verifyNetwork('bitcoin'), /genesis mismatch/);
});

test(
  'fresh custody bootstraps Testnet3 hot0 without rewriting an existing network identity',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const isolated = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    const db = new WalletPrismaService({ databaseUrl: isolated.url });
    try {
      const domainId = 'testnet-' + randomUUID(),
        config = custodySettings(domainId);
      config.chainNetworks = { bitcoin: { network: 'testnet', rpcNetwork: 'test' } };
      const auth = new MessageAuth('q'.repeat(64), randomUUID());
      const custody = new CustodyService(
        db,
        config,
        { domainId, apiKey: 'e'.repeat(64) },
        auth,
        acceptanceRollout,
      );
      const result = await custody.bootstrap();
      const hot = result.hotWallets.find((w) => w.chain === 'bitcoin')!;
      assert.equal(hot.network, 'testnet');
      assert.equal(hot.account, 0);
      assert.equal(hot.path, "m/84'/1'/0'/0/0");
      assert.equal(
        (await db.assetConfiguration.findFirstOrThrow({ where: { chain: 'bitcoin' } })).name,
        'Testnet3 Bitcoin',
      );
      assert.throws(() => custody.validateNetwork('bitcoin', 'regtest'));
      const old = new CustodyService(
        db,
        custodySettings(domainId),
        { domainId, apiKey: 'e'.repeat(64) },
        auth,
        acceptanceRollout,
      );
      await assert.rejects(old.bootstrap(), /network identity is immutable/);
    } finally {
      await db.$disconnect();
      await isolated.drop();
    }
  },
);
