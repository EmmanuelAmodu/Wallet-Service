import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDevelopmentResetPlan,
  epochResourceName,
  localDatabaseName,
  localPubSubEndpoint,
  localRedisUrl,
  postgresResetEnvironment,
  updateEnvContent,
} from '../scripts/reset-development.js';
import { queueConfig } from '../packages/queue/src/queue.config.js';

test('development reset refuses remote and maintenance databases', () => {
  assert.equal(localDatabaseName('postgresql://user:pass@127.0.0.1:5432/wallet'), 'wallet');
  assert.throws(
    () => localDatabaseName('postgresql://user:pass@database.example/wallet'),
    /loopback PostgreSQL/,
  );
  assert.throws(
    () => localDatabaseName('postgresql://user:pass@127.0.0.1:5432/postgres'),
    /maintenance/,
  );
  for (const override of ['host=remote.example', 'hostaddr=203.0.113.7', 'service=remote'])
    assert.throws(
      () => localDatabaseName(`postgresql://user:pass@127.0.0.1:5432/wallet?${override}`),
      /overrides/,
    );
  const env = postgresResetEnvironment(
    'postgresql://user:pass@127.0.0.1:5432/wallet',
    'WALLET_DATABASE_URL',
    { PGHOST: 'remote.example', PGSERVICE: 'remote', PGPORT: '6543' },
  );
  assert.equal(env.WALLET_DATABASE_URL, 'postgresql://user:pass@127.0.0.1:5432/wallet');
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGPORT, undefined);
  assert.equal(localRedisUrl('redis://localhost:6379'), 'redis://localhost:6379');
  assert.throws(() => localRedisUrl('redis://redis.example:6379'), /loopback Redis/);
  assert.equal(localPubSubEndpoint('127.0.0.1:8086'), 'http://127.0.0.1:8086/');
  assert.throws(() => localPubSubEndpoint('https://pubsub.example'), /loopback Pub\/Sub/);
});

test('queue config blocks services while a development reset is fenced', () => {
  const original = process.env.RESET_IN_PROGRESS;
  process.env.RESET_IN_PROGRESS = 'epoch-123';
  try {
    assert.throws(() => queueConfig(), /reset is in progress/);
  } finally {
    if (original === undefined) delete process.env.RESET_IN_PROGRESS;
    else process.env.RESET_IN_PROGRESS = original;
  }
});

test('development reset resource names are epoch-scoped and env updates are stable', () => {
  assert.equal(epochResourceName('activity', '01234567-epoch'), 'activity-01234567');
  const content = updateEnvContent('A=old\nB=kept\n', { A: 'new', RESET_EPOCH: 'epoch-2' });
  assert.equal(content, 'A=new\nB=kept\nRESET_EPOCH=epoch-2\n');
  assert.throws(() => updateEnvContent('A=1\nA=2\n', { A: '3' }), /Duplicate A/);
});

test('development reset resume reuses the persisted epoch and retired namespace', () => {
  const first = createDevelopmentResetPlan({
    resume: false,
    resetEpoch: 'epoch-old',
    currentSubscription: 'activity-old',
    basePrefix: 'waas',
    topicBase: 'activities',
    subscriptionBase: 'activity',
  });
  const resumed = createDevelopmentResetPlan({
    resume: true,
    resetEpoch: first.resetEpoch,
    resetInProgress: first.resetEpoch,
    previousQueuePrefix: first.retiredQueuePrefix,
    previousSubscription: first.previousSubscription,
    currentTopic: first.topic,
    currentSubscription: first.subscription,
    basePrefix: 'waas',
    topicBase: 'activities',
    subscriptionBase: 'activity',
  });

  assert.deepEqual(resumed, first);
  assert.throws(
    () =>
      createDevelopmentResetPlan({
        resume: false,
        resetInProgress: first.resetEpoch,
        basePrefix: 'waas',
        topicBase: 'activities',
        subscriptionBase: 'activity',
      }),
    /resume it/,
  );
});
