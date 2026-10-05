import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  createDevelopmentResetPlan,
  developmentResetConfiguration,
  epochResourceName,
  localDatabaseName,
  localPubSubEndpoint,
  localRedisUrl,
  postgresResetEnvironment,
  runDevelopmentReset,
  updateEnvContent,
} from '../scripts/reset-development.js';
import { queueConfig } from '../packages/queue/src/queue.config.js';
import {
  assertResetReady,
  readResetEnvironment,
} from '../packages/shared/src/development-reset.js';

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

test('reset requires explicit distinct databases for every service and rejects endpoint overrides', () => {
  const names = [
    'WALLET_DATABASE_URL',
    'BROADCAST_DATABASE_URL',
    'LEDGER_DATABASE_URL',
    'ACTIVITY_DATABASE_URL',
    'SWEEP_DATABASE_URL',
    'USER_DATABASE_URL',
  ];
  const environment: NodeJS.ProcessEnv = { REDIS_URL: 'redis://127.0.0.1:6379/15' };
  for (let index = 0; index < names.length; index++)
    environment[names[index]] = `postgresql://user:pass@127.0.0.1:${5432 + index}/owned_service`;
  assert.equal(developmentResetConfiguration(environment).urls.length, 6);
  for (const name of names) {
    const incomplete = { ...environment };
    delete incomplete[name];
    assert.throws(
      () => developmentResetConfiguration(incomplete),
      new RegExp(`Missing configuration: ${name}`),
    );
  }
  assert.throws(
    () =>
      developmentResetConfiguration({
        ...environment,
        USER_DATABASE_URL: 'postgresql://different:pass@localhost:5432/owned_service',
      }),
    /six distinct owned service databases/,
  );
  for (const value of [
    'redis://localhost:6379/15?host=other',
    'redis://localhost:6379/15#override',
    'redis://localhost:6379/not-a-database',
  ])
    assert.throws(() => localRedisUrl(value), /overrides|invalid database paths/);
  for (const value of [
    'http://localhost:8086/path',
    'http://user:pass@localhost:8086',
    'http://localhost:8086?endpoint=other',
    'ftp://localhost:8086',
  ])
    assert.throws(() => localPubSubEndpoint(value), /overrides|paths|loopback Pub/);
});

test('resume rejects changed queue/project or replacement names before destructive work', async (t) => {
  for (const changed of ['foreign-prefix', 'current-queue', 'topic', 'subscription']) {
    const envPath = await resetFixture(t);
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        performReset: async () => {
          throw new Error('Injected reset interruption');
        },
      }),
      /Injected reset interruption/,
    );
    const disk = readResetEnvironment(envPath);
    const values: Record<string, string> =
      changed === 'foreign-prefix'
        ? { RESET_PREVIOUS_QUEUE_PREFIX: 'another-project:epoch-old' }
        : changed === 'current-queue'
          ? { RESET_PREVIOUS_QUEUE_PREFIX: `waas:${disk.RESET_EPOCH}` }
          : changed === 'topic'
            ? { PUBSUB_TOPIC: 'foreign-topic' }
            : { PUBSUB_SUBSCRIPTION: 'foreign-subscription' };
    await writeFile(envPath, updateEnvContent(await readFile(envPath, 'utf8'), values));
    let mutations = 0;
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        resume: true,
        performReset: async () => {
          mutations++;
        },
      }),
      /another project prefix|current reset namespace|does not match the reset epoch/,
    );
    assert.equal(mutations, 0);
    assert.equal(readResetEnvironment(envPath).RESET_IN_PROGRESS, disk.RESET_IN_PROGRESS);
  }
});

test('development reset resource names are epoch-scoped and env updates are stable', () => {
  assert.equal(epochResourceName('activity', '01234567-epoch'), 'activity-01234567');
  const content = updateEnvContent('A=old\nB=kept\n', { A: 'new', RESET_EPOCH: 'epoch-2' });
  assert.equal(content, 'A=new\nB=kept\nRESET_EPOCH=epoch-2\n');
  assert.throws(() => updateEnvContent('A=1\nA=2\n', { A: '3' }), /Duplicate A/);
  assert.equal(
    updateEnvContent('export RESET_EPOCH = old\n', { RESET_EPOCH: 'new' }),
    'RESET_EPOCH=new\n',
  );
});

test('environment updates preserve quoted fake controls and replace only real assignments', () => {
  for (const quote of ['"', "'", '`']) {
    const other = `header\nRESET_IN_PROGRESS=fake\nfooter`;
    const content = `OTHER=${quote}${other}${quote}\nKEEP=unchanged\n`;
    for (const hasMarker of [false, true]) {
      const updated = updateEnvContent(content + (hasMarker ? 'RESET_IN_PROGRESS=\n' : ''), {
        RESET_IN_PROGRESS: 'actual-epoch',
      });
      const parsed = parseEnv(updated);
      assert.equal(parsed.OTHER, other);
      assert.equal(parsed.KEEP, 'unchanged');
      assert.equal(parsed.RESET_IN_PROGRESS, 'actual-epoch');
      assert.equal(updated, `${content}RESET_IN_PROGRESS=actual-epoch\n`);
    }
  }
});

test('environment updates replace complete multiline control spans without corrupting later values', () => {
  const content = [
    '# retained comment',
    'export RESET_IN_PROGRESS = "old',
    'RESET_EPOCH=quoted fake',
    'value"',
    'KEEP=unchanged',
    "RESET_EPOCH='old",
    "epoch'",
    'LAST=retained',
    '',
  ].join('\n');
  const updated = updateEnvContent(content, {
    RESET_IN_PROGRESS: 'actual-epoch',
    RESET_EPOCH: 'actual-epoch',
  });
  assert.equal(
    updated,
    '# retained comment\nRESET_IN_PROGRESS=actual-epoch\nKEEP=unchanged\nRESET_EPOCH=actual-epoch\nLAST=retained\n',
  );
  assert.equal(parseEnv(updated).LAST, 'retained');
});

async function resetFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wallet-reset-run-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = join(directory, '.env');
  await writeFile(
    envPath,
    'RESET_EPOCH=epoch-old\nRESET_IN_PROGRESS=\nPUBSUB_TOPIC=activity-old\nPUBSUB_SUBSCRIPTION=subscription-old\n',
  );
  return envPath;
}

test('quoted fake markers cannot hide the durable fence before reset or after failure', async (t) => {
  for (const hasMarker of [false, true]) {
    const envPath = await resetFixture(t);
    const other = 'header\nRESET_IN_PROGRESS=quoted fake\nfooter';
    const quoted = `OTHER="${other}"\n`;
    await writeFile(
      envPath,
      `RESET_EPOCH=epoch-old\n${quoted}${hasMarker ? 'RESET_IN_PROGRESS=\n' : ''}`,
    );
    let expectedEpoch = '';
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        performReset: async (_environment, plan) => {
          expectedEpoch = plan.resetEpoch;
          const disk = readResetEnvironment(envPath);
          assert.equal(disk.RESET_IN_PROGRESS, expectedEpoch);
          assert.equal(disk.RESET_EPOCH, expectedEpoch);
          assert.equal(disk.OTHER, other);
          throw new Error('Injected reset failure');
        },
      }),
      /Injected reset failure/,
    );
    assert.ok(expectedEpoch);
    const disk = readResetEnvironment(envPath);
    assert.equal(disk.RESET_IN_PROGRESS, expectedEpoch);
    assert.equal(disk.RESET_EPOCH, expectedEpoch);
    assert.equal(disk.OTHER, other);
    assert.ok((await readFile(envPath, 'utf8')).includes(quoted));
    assert.throws(
      () => assertResetReady({ RESET_IN_PROGRESS: '' }, envPath),
      /reset is in progress/,
    );
  }
});

test('resume refuses destructive callbacks if preparation changes its durable fence', async (t) => {
  for (const key of ['RESET_IN_PROGRESS', 'RESET_EPOCH']) {
    const envPath = await resetFixture(t);
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        performReset: async () => {
          throw new Error('Injected reset failure');
        },
      }),
      /Injected reset failure/,
    );
    let mutations = 0;
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        resume: true,
        prepare: () => {
          const disk = readResetEnvironment(envPath);
          disk[key] = 'foreign-epoch';
          writeFileSync(
            envPath,
            Object.entries(disk)
              .map(([name, value]) => `${name}=${value}`)
              .join('\n') + '\n',
          );
        },
        performReset: async () => {
          mutations++;
        },
      }),
      /Durable reset fence is missing or changed/,
    );
    assert.equal(mutations, 0);
    assert.equal(readResetEnvironment(envPath)[key], 'foreign-epoch');
  }
});

test('failed reset keeps its durable fence and resumes despite stale exported controls', async (t) => {
  const envPath = await resetFixture(t);
  const inherited = {
    RESET_EPOCH: 'epoch-old',
    RESET_IN_PROGRESS: '',
    PUBSUB_TOPIC: 'activity-old',
    PUBSUB_SUBSCRIPTION: 'subscription-old',
  };
  let failedPlan: unknown;
  await assert.rejects(
    runDevelopmentReset({
      envPath,
      environment: inherited,
      performReset: async (environment, plan) => {
        failedPlan = plan;
        const disk = readResetEnvironment(envPath);
        assert.equal(disk.RESET_IN_PROGRESS, plan.resetEpoch);
        assert.equal(environment.RESET_EPOCH, plan.resetEpoch);
        throw new Error('Injected cleanup failure');
      },
    }),
    /Injected cleanup failure/,
  );
  const fenced = readResetEnvironment(envPath);
  assert.notEqual(fenced.RESET_EPOCH, inherited.RESET_EPOCH);
  assert.equal(fenced.RESET_EPOCH, fenced.RESET_IN_PROGRESS);
  assert.throws(() => assertResetReady(inherited, envPath), /reset is in progress/);
  let mutations = 0;
  await assert.rejects(
    runDevelopmentReset({
      envPath,
      environment: inherited,
      performReset: async () => {
        mutations++;
      },
    }),
    /resume it/,
  );
  assert.equal(mutations, 0);
  const resumed = await runDevelopmentReset({
    envPath,
    environment: inherited,
    resume: true,
    performReset: async (_environment, plan) => {
      assert.deepEqual(plan, failedPlan);
    },
  });
  const complete = readResetEnvironment(envPath);
  assert.equal(complete.RESET_IN_PROGRESS, '');
  assert.equal(complete.RESET_EPOCH, resumed.resetEpoch);
  assert.throws(() => assertResetReady(inherited, envPath), /differs from durable reset state/);
  assert.doesNotThrow(() => assertResetReady({ RESET_EPOCH: resumed.resetEpoch }, envPath));
});

test('competing reset and resume perform no mutations while one reset owns the lock', async (t) => {
  const envPath = await resetFixture(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = runDevelopmentReset({
    envPath,
    environment: {},
    performReset: async () => {
      enter();
      await waiting;
    },
  });
  await entered;
  try {
    const disk = readResetEnvironment(envPath);
    let mutations = 0;
    for (const resume of [false, true]) {
      await assert.rejects(
        runDevelopmentReset({
          envPath,
          environment: {},
          resume,
          performReset: async () => {
            mutations++;
          },
        }),
        /reset lock exists/,
      );
    }
    assert.equal(mutations, 0);
    assert.deepEqual(readResetEnvironment(envPath), disk);
  } finally {
    finish();
    await first;
  }
  assert.equal(readResetEnvironment(envPath).RESET_IN_PROGRESS, '');
});

test('reset completion cannot clear a foreign epoch or marker', async (t) => {
  for (const changedKey of ['RESET_EPOCH', 'RESET_IN_PROGRESS']) {
    const envPath = await resetFixture(t);
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment: {},
        performReset: async () => {
          const values = readResetEnvironment(envPath);
          values[changedKey] = 'foreign-epoch';
          await writeFile(
            envPath,
            Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join('\n') + '\n',
          );
        },
      }),
      /refusing to clear another reset fence/,
    );
    assert.equal(readResetEnvironment(envPath)[changedKey], 'foreign-epoch');
    assert.ok(readResetEnvironment(envPath).RESET_IN_PROGRESS);
  }
});

test('configuration validation failure occurs before fencing or destructive callbacks', async (t) => {
  const envPath = await resetFixture(t);
  const initial = readResetEnvironment(envPath);
  let mutated = false;
  await assert.rejects(
    runDevelopmentReset({
      envPath,
      environment: {},
      prepare: () => {
        throw new Error('Invalid configuration');
      },
      performReset: async () => {
        mutated = true;
      },
    }),
    /Invalid configuration/,
  );
  assert.equal(mutated, false);
  assert.deepEqual(readResetEnvironment(envPath), initial);
});

test('durable production configuration rejects reset before preparation or mutation', async (t) => {
  const envPath = await resetFixture(t);
  const content = (await readFile(envPath, 'utf8')) + 'NODE_ENV=production\n';
  await writeFile(envPath, content);
  let prepared = false;
  let mutated = false;
  await assert.rejects(
    runDevelopmentReset({
      envPath,
      environment: { NODE_ENV: 'development' },
      prepare: () => {
        prepared = true;
      },
      performReset: async () => {
        mutated = true;
      },
    }),
    /disabled in production/,
  );
  assert.equal(prepared, false);
  assert.equal(mutated, false);
  assert.equal(await readFile(envPath, 'utf8'), content);
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
