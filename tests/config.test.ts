import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chainNetworksFromEnv,
  chainNetworkOverridesFromEnv,
  networkFor,
} from '../packages/chain/src/config.js';
import { integerSetting } from '../packages/shared/src/config.js';

test('integer settings use defaults and reject malformed or out-of-range values', (t) => {
  const original = process.env.TEST_INTEGER_SETTING;
  t.after(() => {
    if (original === undefined) delete process.env.TEST_INTEGER_SETTING;
    else process.env.TEST_INTEGER_SETTING = original;
  });

  delete process.env.TEST_INTEGER_SETTING;
  assert.equal(integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535), 3000);

  for (const value of ['0', '65536', '-1', '2.5', 'invalid']) {
    process.env.TEST_INTEGER_SETTING = value;
    assert.throws(
      () => integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535),
      /Invalid configuration: TEST_INTEGER_SETTING/,
    );
  }

  process.env.TEST_INTEGER_SETTING = '8080';
  assert.equal(integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535), 8080);
});

test('chain network settings require per-chain RPC and EVM chain identifiers', (t) => {
  const original = process.env.CHAIN_NETWORKS;
  t.after(() => {
    if (original === undefined) delete process.env.CHAIN_NETWORKS;
    else process.env.CHAIN_NETWORKS = original;
  });

  process.env.CHAIN_NETWORKS = JSON.stringify({
    polygon: { network: '137', chainId: '137', rpcUrl: 'https://polygon.example' },
    litecoin: { network: 'mainnet', rpcUrl: 'https://litecoin.example' },
  });
  const chainNetworks = chainNetworksFromEnv('11155111', 'devnet');
  assert.equal(
    networkFor('polygon', {
      ethereumChainId: '11155111',
      solanaGenesisHash: 'devnet',
      chainNetworks,
    }),
    '137',
  );
  assert.equal(chainNetworks.litecoin.rpcUrl, 'https://litecoin.example');

  process.env.CHAIN_NETWORKS = JSON.stringify({
    polygon: { network: '137', rpcUrl: 'https://polygon.example' },
  });
  assert.throws(() => chainNetworkOverridesFromEnv(), /chainId/);

  process.env.CHAIN_NETWORKS = JSON.stringify({
    polygon: { network: '137', chainId: '137' },
  });
  assert.throws(() => chainNetworksFromEnv('11155111', 'devnet'), /rpcUrl/);

  process.env.CHAIN_NETWORKS = '{';
  assert.throws(() => chainNetworkOverridesFromEnv(), /valid JSON/);
});

test('application configuration is scoped and rejects unsafe settings at startup', async (t) => {
  const { walletConfig } = await import('../apps/wallet/src/config/wallet.config.js');
  const { broadcastConfig } = await import('../apps/broadcast/src/config/broadcast.config.js');
  const { signerConfig } = await import('../apps/signer/src/config/signer.config.js');
  const { ledgerConfig } = await import('../apps/ledger/src/config/ledger.config.js');
  const { activityListenerConfig } =
    await import('../apps/activity-listener/src/config/activity-listener.config.js');
  const names = [
    'WALLET_DATABASE_URL',
    'BROADCAST_DATABASE_URL',
    'LEDGER_DATABASE_URL',
    'LEDGER_API_KEY',
    'WALLET_API_KEYS',
    'QUEUE_AUTH_KEY',
    'SIGNER_SEED_FILE',
    'SIGNER_SEED_ID',
    'ETH_CHAIN_ID',
    'SOLANA_GENESIS_HASH',
    'CHAIN_NETWORKS',
    'ALLOW_BROADCAST',
    'WALLET_PORT',
    'PUBSUB_PROJECT_ID',
    'PUBSUB_SUBSCRIPTION',
    'PUBSUB_API_ENDPOINT',
    'NODE_ENV',
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  Object.assign(process.env, {
    SIGNER_SEED_FILE: '/test/seed',
    SIGNER_SEED_ID: 'test',
    ETH_CHAIN_ID: '11155111',
  });
  Object.assign(process.env, {
    LEDGER_DATABASE_URL: 'postgresql://localhost/ledger',
    LEDGER_API_KEY: 'c'.repeat(64),
    QUEUE_AUTH_KEY: 'b'.repeat(64),
    PUBSUB_PROJECT_ID: 'test-project',
    PUBSUB_SUBSCRIPTION: 'test-subscription',
    PUBSUB_API_ENDPOINT: '127.0.0.1:8086',
  });
  assert.equal(ledgerConfig().apiKey, 'c'.repeat(64));
  assert.equal(activityListenerConfig().pubsubSubscription, 'test-subscription');
  process.env.NODE_ENV = 'production';
  process.env.LEDGER_API_KEY = 'b'.repeat(64);
  process.env.QUEUE_AUTH_KEY = 'b'.repeat(64);
  assert.throws(() => ledgerConfig(), /distinct ledger API key/);
  process.env.NODE_ENV = 'test';
  assert.equal(signerConfig().seedId, 'test');
  delete process.env.SIGNER_SEED_FILE;
  delete process.env.SIGNER_SEED_ID;
  Object.assign(process.env, {
    BROADCAST_DATABASE_URL: 'postgresql://localhost/broadcast',
    SOLANA_GENESIS_HASH: 'devnet',
  });
  assert.equal(broadcastConfig().allowBroadcast, false);
  process.env.ALLOW_BROADCAST = 'yes';
  assert.throws(() => broadcastConfig(), /ALLOW_BROADCAST/);
  Object.assign(process.env, {
    WALLET_DATABASE_URL: 'postgresql://localhost/wallet',
    WALLET_API_KEYS: JSON.stringify({ tenant: 'a'.repeat(64) }),
    QUEUE_AUTH_KEY: 'a'.repeat(64),
    SIGNER_SEED_ID: 'test',
  });
  assert.throws(() => walletConfig(), /distinct/);
  process.env.QUEUE_AUTH_KEY = 'b'.repeat(64);
  process.env.WALLET_API_KEYS = JSON.stringify({ tenant: 'a'.repeat(64), other: 'a'.repeat(64) });
  assert.throws(() => walletConfig(), /unique/);
  process.env.WALLET_API_KEYS = JSON.stringify({ tenant: 'a'.repeat(64) });
  process.env.WALLET_PORT = '70000';
  assert.throws(() => walletConfig(), /WALLET_PORT/);
  process.env.WALLET_PORT = '3000';
  assert.equal(walletConfig().port, 3000);
});
