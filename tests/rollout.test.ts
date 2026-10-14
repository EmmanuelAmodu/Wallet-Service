import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  rolloutConfig,
  rolloutAllows,
  closedRollout,
  assertRollout,
} from '../packages/shared/src/rollout.config.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';
const scope = { domainId: 'exchange', chain: 'ethereum', network: '11155111' };
test('rollout defaults closed and absent flags cannot enable credit or spending', () => {
  for (const action of ['addresses', 'credits', 'sweeps', 'withdrawals'] as const) {
    assert.equal(rolloutAllows(closedRollout, action, scope), false);
    assert.throws(() => assertRollout(closedRollout, action, scope), /paused by rollout/);
  }
});
test('independent rollout switches also apply to token sweeps and withdrawals', () => {
  for (const action of ['addresses', 'credits', 'sweeps', 'withdrawals'] as const) {
    const settings = { ...acceptanceRollout, [action]: false };
    for (const other of ['addresses', 'credits', 'sweeps', 'withdrawals'] as const)
      assert.equal(rolloutAllows(settings, other, scope), action !== other);
  }
});
test('dry-run forbids spending even when spending switches are true', () => {
  const settings = { ...acceptanceRollout, mode: 'dry-run' as const };
  assert.equal(rolloutAllows(settings, 'addresses', scope), true);
  assert.equal(rolloutAllows(settings, 'credits', scope), true);
  assert.equal(rolloutAllows(settings, 'sweeps', scope), false);
  assert.equal(rolloutAllows(settings, 'withdrawals', scope), false);
});
test('canary requires exactly one domain, chain and network at every gated action', () => {
  const settings = { ...acceptanceRollout, mode: 'canary' as const, canary: scope };
  for (const action of ['addresses', 'credits', 'sweeps', 'withdrawals'] as const) {
    assert.equal(rolloutAllows(settings, action, scope), true);
    for (const changed of [{ domainId: 'other' }, { chain: 'solana' }, { network: '1' }])
      assert.equal(rolloutAllows(settings, action, { ...scope, ...changed }), false);
    assert.equal(rolloutAllows({ ...settings, canary: undefined }, action, scope), false);
  }
});
test('rollout config rejects malformed switches and unsupported canary networks', () => {
  const keys = [
    'EXCHANGE_ROLLOUT_MODE',
    'ENABLE_DEPOSIT_CREDIT',
    'EXCHANGE_CANARY_CHAIN',
    'EXCHANGE_CANARY_NETWORK',
    'EXCHANGE_DOMAIN_ID',
  ];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.ENABLE_DEPOSIT_CREDIT = 'yes';
    assert.throws(() => rolloutConfig());
    process.env.ENABLE_DEPOSIT_CREDIT = 'true';
    process.env.EXCHANGE_ROLLOUT_MODE = 'canary';
    process.env.EXCHANGE_CANARY_CHAIN = 'ethereum';
    process.env.EXCHANGE_CANARY_NETWORK = '1';
    process.env.EXCHANGE_DOMAIN_ID = 'exchange';
    assert.throws(() => rolloutConfig(), /pinned network/);
    process.env.EXCHANGE_CANARY_NETWORK = '11155111';
    assert.deepEqual(rolloutConfig().canary, scope);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test('acceptance evidence rejects skipped tests and incomplete TAP; infrastructure is loopback and Redis is isolated', async () => {
  const { acceptanceCounts, localAcceptanceUrl } =
    await import('../scripts/exchange-acceptance.js');
  assert.deepEqual(
    acceptanceCounts('# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n'),
    { tests: 2, pass: 2, fail: 0, skipped: 0, cancelled: 0 },
  );
  assert.throws(
    () => acceptanceCounts('# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n'),
    /no skipped/,
  );
  assert.throws(() => acceptanceCounts('test started'), /passing tests/);
  assert.throws(
    () => localAcceptanceUrl('postgresql://u:p@remote.example/db', 'postgresql:'),
    /loopback/,
  );
  assert.throws(() => localAcceptanceUrl('redis://127.0.0.1:6379/0', 'redis:'), /nonzero/);
  assert.equal(localAcceptanceUrl('redis://127.0.0.1:6379/15', 'redis:').pathname, '/15');
});
