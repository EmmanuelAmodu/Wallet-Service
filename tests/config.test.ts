import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerSetting } from '../packages/shared/src/config';

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

test('application configuration is scoped and rejects unsafe settings at startup', async (t) => {
  const { walletConfig } = await import('../apps/wallet/src/config/wallet.config.js');
  const { broadcastConfig } = await import('../apps/broadcast/src/config/broadcast.config.js');
  const { signerConfig } = await import('../apps/signer/src/config/signer.config.js');
  const names = [
    'WALLET_DATABASE_URL',
    'BROADCAST_DATABASE_URL',
    'WALLET_API_KEYS',
    'QUEUE_AUTH_KEY',
    'SIGNER_SEED_FILE',
    'SIGNER_SEED_ID',
    'ETH_CHAIN_ID',
    'SOLANA_GENESIS_HASH',
    'ALLOW_BROADCAST',
    'WALLET_PORT',
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
