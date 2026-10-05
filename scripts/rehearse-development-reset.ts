import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PubSub } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { Client } from 'pg';
import { initWasm } from '@trustwallet/wallet-core';
import { ActivityPubSubService } from '../apps/activity-listener/src/activity-pubsub.service.js';
import { connection } from '../packages/queue/src/messaging.module.js';
import { epochQueuePrefix } from '../packages/queue/src/queue.config.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import {
  assertResetReady,
  readResetEnvironment,
} from '../packages/shared/src/development-reset.js';
import {
  DevelopmentResetPlan,
  developmentResetConfiguration,
  localDatabaseName,
  localPubSubEndpoint,
  localRedisUrl,
  performDevelopmentReset,
  runDevelopmentReset,
} from './reset-development.js';
import { bootstrapResetRehearsal } from './reset-rehearsal-bootstrap.js';

const targets = [
  ['wallet', 'TEST_DATABASE_URL', 'WALLET_DATABASE_URL'],
  ['broadcast', 'TEST_BROADCAST_DATABASE_URL', 'BROADCAST_DATABASE_URL'],
  ['ledger', 'TEST_LEDGER_DATABASE_URL', 'LEDGER_DATABASE_URL'],
  ['activity', 'TEST_ACTIVITY_DATABASE_URL', 'ACTIVITY_DATABASE_URL'],
  ['sweep', 'TEST_SWEEP_DATABASE_URL', 'SWEEP_DATABASE_URL'],
  ['user', 'TEST_USER_DATABASE_URL', 'USER_DATABASE_URL'],
] as const;

export interface ResetRehearsalContext {
  round: 1 | 2;
  environment: NodeJS.ProcessEnv;
  plan: DevelopmentResetPlan;
}

export interface ResetBootstrapAcceptance {
  hotAddress: string;
  hotAddresses?: Record<string, string>;
  firstCustomerAccount: number;
  customerLiabilityUnits: string;
}

async function postgres<T>(url: string, action: (db: Client) => Promise<T>) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < end);
  throw new Error('Isolated rehearsal asynchronous delivery timed out');
}

// Every database and Pub/Sub resource is newly created by this harness; existing
// TEST_* databases provide only a connection/role with permission to create siblings.
export async function rehearseDevelopmentReset(
  options: {
    environment?: NodeJS.ProcessEnv;
    bootstrap?: (context: ResetRehearsalContext) => Promise<ResetBootstrapAcceptance>;
  } = {},
) {
  const supplied = options.environment ?? process.env;
  const bootstrap = options.bootstrap ?? bootstrapResetRehearsal;
  if (supplied.NODE_ENV === 'production') throw new Error('Rehearsal is disabled in production');
  const selected = targets.map(([name, testEnv, appEnv]) => {
    const url = supplied[testEnv];
    if (!url) throw new Error(`Isolated rehearsal requires ${testEnv}`);
    localDatabaseName(url);
    return { name, appEnv, originalUrl: url };
  });
  if (!supplied.TEST_REDIS_URL) throw new Error('Isolated rehearsal requires TEST_REDIS_URL');
  const redisUrl = localRedisUrl(supplied.TEST_REDIS_URL);
  const apiEndpoint = localPubSubEndpoint(supplied.TEST_PUBSUB_API_ENDPOINT ?? '127.0.0.1:8086');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wallet-reset-rehearsal-')));
  const envPath = join(directory, 'reset.env');
  const oldEpoch = randomUUID();
  const queuePrefix = `reset-rehearsal-${suffix}`;
  const foreignPrefix = epochQueuePrefix(`unrelated-rehearsal-${suffix}`, oldEpoch);
  const projectId = `wallet-reset-${suffix}`;
  const oldTopic = `rehearsal-old-topic-${suffix}`;
  const oldSubscription = `rehearsal-old-subscription-${suffix}`;
  const foreignTopic = `rehearsal-foreign-topic-${suffix}`;
  const foreignSubscription = `rehearsal-foreign-subscription-${suffix}`;
  const createdDatabases: { originalUrl: string; url: string; name: string }[] = [];
  const queueNamespaces = new Set([epochQueuePrefix(queuePrefix, oldEpoch), foreignPrefix]);
  const topics = new Set<string>();
  const subscriptions = new Set<string>();
  const queueHandles: Queue[] = [];
  const pubsub = new PubSub({ projectId, apiEndpoint });
  const queue = (name: string, prefix: string) => {
    const instance = new Queue(name, { connection: connection(redisUrl), prefix });
    queueHandles.push(instance);
    return instance;
  };
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    RESET_ENV_FILE: envPath,
    RESET_EPOCH: oldEpoch,
    RESET_IN_PROGRESS: '',
    QUEUE_PREFIX: queuePrefix,
    REDIS_URL: redisUrl,
    QUEUE_AUTH_KEY: 'a'.repeat(64),
    PUBSUB_PROJECT_ID: projectId,
    PUBSUB_API_ENDPOINT: apiEndpoint,
    PUBSUB_TOPIC_BASE: `rehearsal-topic-${suffix}`,
    PUBSUB_SUBSCRIPTION_BASE: `rehearsal-subscription-${suffix}`,
    PUBSUB_TOPIC: oldTopic,
    PUBSUB_SUBSCRIPTION: oldSubscription,
    EXCHANGE_DOMAIN_ID: `reset-rehearsal-${suffix}`,
    SIGNER_SEED_ID: `rehearsal-${suffix}`,
    SIGNER_SEED_FILE: join(directory, 'seed.mnemonic'),
    ETH_CHAIN_ID: '11155111',
    SOLANA_GENESIS_HASH: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  };
  const cleanupErrors: unknown[] = [];
  let failed = false;
  let operationError: unknown;
  let report:
    | {
        databaseOwners: number;
        resetRounds: number;
        failureResumeVerified: boolean;
        staleQueueRejected: boolean;
        staleProviderQuarantined: boolean;
        foreignResourcesPreserved: boolean;
        emptyLedgerVerified: boolean;
        bootstrapVerified: boolean;
      }
    | undefined;
  try {
    // Establish availability before creating any databases or queue jobs.
    await pubsub.getTopics({ pageSize: 1 });
    const availabilityQueue = queue(QUEUES.wallet, foreignPrefix);
    await availabilityQueue.getJobCounts();
    const core = await initWasm();
    const wallet = core.HDWallet.create(256, '');
    try {
      await writeFile(environment.SIGNER_SEED_FILE!, wallet.mnemonic() + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } finally {
      wallet.delete();
    }
    for (const target of selected) {
      const name = `waas_reset_${target.name}_${suffix}`;
      await postgres(target.originalUrl, (db) => db.query(`CREATE DATABASE "${name}"`));
      const url = new URL(target.originalUrl);
      url.pathname = `/${name}`;
      const created = { originalUrl: target.originalUrl, url: url.toString(), name };
      createdDatabases.push(created);
      environment[target.appEnv] = created.url;
      await postgres(created.url, async (db) => {
        await db.query('CREATE TABLE reset_rehearsal_marker (id INTEGER PRIMARY KEY)');
        await db.query('INSERT INTO reset_rehearsal_marker VALUES (1)');
      });
    }
    developmentResetConfiguration(environment);
    await writeFile(
      envPath,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    for (const [topic, subscription] of [
      [oldTopic, oldSubscription],
      [foreignTopic, foreignSubscription],
    ]) {
      await pubsub.topic(topic).create();
      topics.add(topic);
      await pubsub.topic(topic).createSubscription(subscription);
      subscriptions.add(subscription);
    }
    const payload = { type: 'transaction.prepare' as const, transactionId: randomUUID() };
    const staleAuth = new MessageAuth(environment.QUEUE_AUTH_KEY!, oldEpoch);
    for (const name of Object.values(QUEUES))
      await queue(name, epochQueuePrefix(queuePrefix, oldEpoch)).add(
        payload.type,
        staleAuth.seal(payload, 'old-job'),
        { jobId: 'old-job' },
      );
    await availabilityQueue.add(payload.type, staleAuth.seal(payload, 'foreign-job'), {
      jobId: 'foreign-job',
    });
    let failedPlan: DevelopmentResetPlan | undefined;
    await assert.rejects(
      runDevelopmentReset({
        envPath,
        environment,
        prepare: (active) => {
          developmentResetConfiguration(active);
        },
        performReset: async (active, plan) => {
          failedPlan = plan;
          topics.add(plan.topic);
          subscriptions.add(plan.subscription);
          queueNamespaces.add(epochQueuePrefix(queuePrefix, plan.resetEpoch));
          await performDevelopmentReset(active, plan, (step) => {
            if (step === 'database:ledger')
              throw new Error('Injected failure after third database');
          });
        },
      }),
      /Injected failure after third database/,
    );
    assert.ok(failedPlan);
    assert.equal(readResetEnvironment(envPath).RESET_IN_PROGRESS, failedPlan.resetEpoch);
    assert.throws(() => assertResetReady(environment, envPath), /reset is in progress/);
    assert.equal((await pubsub.subscription(oldSubscription).exists())[0], true);
    assert.ok(await availabilityQueue.getJob('foreign-job'));
    const currentQueue = queue(QUEUES.wallet, epochQueuePrefix(queuePrefix, failedPlan.resetEpoch));
    await currentQueue.add(
      payload.type,
      new MessageAuth(environment.QUEUE_AUTH_KEY!, failedPlan.resetEpoch).seal(payload, 'new-job'),
      { jobId: 'new-job' },
    );
    const resumed = await runDevelopmentReset({
      envPath,
      environment,
      resume: true,
      prepare: (active) => {
        developmentResetConfiguration(active);
      },
      performReset: performDevelopmentReset,
    });
    assert.deepEqual(resumed, failedPlan);
    assert.equal(readResetEnvironment(envPath).RESET_IN_PROGRESS, '');
    assert.throws(() => assertResetReady(environment, envPath), /differs from durable reset state/);
    assert.equal((await pubsub.subscription(oldSubscription).exists())[0], false);
    assert.equal((await pubsub.subscription(foreignSubscription).exists())[0], true);
    assert.ok(await availabilityQueue.getJob('foreign-job'));
    assert.ok(await currentQueue.getJob('new-job'));
    for (const name of Object.values(QUEUES))
      assert.equal(
        await queue(name, epochQueuePrefix(queuePrefix, oldEpoch)).getJob('old-job'),
        undefined,
      );
    const bootstrapResults: ResetBootstrapAcceptance[] = [];
    for (const round of [1, 2] as const) {
      let plan = resumed;
      if (round === 2)
        plan = await runDevelopmentReset({
          envPath,
          environment,
          prepare: (active) => {
            developmentResetConfiguration(active);
          },
          performReset: async (active, replacement) => {
            topics.add(replacement.topic);
            subscriptions.add(replacement.subscription);
            queueNamespaces.add(epochQueuePrefix(queuePrefix, replacement.resetEpoch));
            await performDevelopmentReset(active, replacement);
          },
        });
      const active = { ...environment, ...readResetEnvironment(envPath) };
      assert.doesNotThrow(() => assertResetReady(active, envPath));
      for (const target of createdDatabases) {
        const result = await postgres(target.url, (db) =>
          db.query("SELECT to_regclass('public.reset_rehearsal_marker') AS marker"),
        );
        assert.equal(result.rows[0].marker, null);
      }
      const ledgerUrl = active.LEDGER_DATABASE_URL!;
      await postgres(ledgerUrl, async (db) => {
        for (const table of [
          'ledger_accounts',
          'journal_batches',
          'ledger_entries',
          'exchange_customers',
        ]) {
          const result = await db.query(`SELECT count(*)::integer AS count FROM "${table}"`);
          assert.equal(result.rows[0].count, 0, `Reset must leave ${table} empty`);
        }
      });
      const currentAuth = new MessageAuth(active.QUEUE_AUTH_KEY!, plan.resetEpoch);
      assert.throws(
        () => currentAuth.open(staleAuth.seal(payload, 'stale-job'), 'stale-job', payload.type),
        /epoch/i,
      );
      const activityQueue = queue(QUEUES.activity, epochQueuePrefix(queuePrefix, plan.resetEpoch));
      const listener = new ActivityPubSubService(
        {
          pubsubProjectId: projectId,
          pubsubSubscription: plan.subscription,
          pubsubApiEndpoint: apiEndpoint,
          finalityPollMs: 100,
          finalityMaxPolls: 2,
          reconciliationPollMs: 100,
        },
        currentAuth,
        activityQueue,
      );
      listener.onModuleInit();
      try {
        const id = await pubsub
          .topic(plan.topic)
          .publishMessage({ json: { schemaVersion: 1, resetEpoch: oldEpoch } });
        const quarantineId = `activity-invalid-${createHash('sha256').update(id).digest('hex')}`;
        const job = await waitFor(
          async () => (await activityQueue.getJob(quarantineId)) ?? undefined,
        );
        const message = currentAuth.open(job.data, job.id!, job.name);
        assert.equal(message.type, 'activity.invalid');
        if (message.type === 'activity.invalid')
          assert.match(message.reason, /Stale provider event reset epoch/);
      } finally {
        await listener.onApplicationShutdown();
      }
      if (bootstrap) {
        const result = await bootstrap({ round, environment: active, plan });
        assert.equal(result.firstCustomerAccount, 10);
        assert.equal(result.customerLiabilityUnits, '0');
        assert.ok(result.hotAddress);
        bootstrapResults.push(result);
      }
    }
    if (bootstrapResults.length === 2)
      assert.equal(bootstrapResults[0].hotAddress, bootstrapResults[1].hotAddress);
    if (bootstrapResults[0]?.hotAddresses && bootstrapResults[1]?.hotAddresses)
      assert.deepEqual(bootstrapResults[0].hotAddresses, bootstrapResults[1].hotAddresses);
    report = {
      databaseOwners: targets.length,
      resetRounds: 2,
      failureResumeVerified: true,
      staleQueueRejected: true,
      staleProviderQuarantined: true,
      foreignResourcesPreserved: true,
      emptyLedgerVerified: true,
      bootstrapVerified: bootstrapResults.length === 2,
    };
  } catch (error) {
    failed = true;
    operationError = error;
  } finally {
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const handle of queueHandles) await clean(() => handle.close());
    for (const prefix of queueNamespaces)
      for (const name of Object.values(QUEUES)) {
        const handle = new Queue(name, { connection: connection(redisUrl), prefix });
        await clean(async () => {
          try {
            await handle.obliterate({ force: true });
          } finally {
            await handle.close();
          }
        });
      }
    for (const subscription of subscriptions) {
      const handle = pubsub.subscription(subscription);
      await clean(async () => {
        if ((await handle.exists())[0]) await handle.delete();
      });
    }
    for (const topic of topics) {
      const handle = pubsub.topic(topic);
      await clean(async () => {
        if ((await handle.exists())[0]) await handle.delete();
      });
    }
    await clean(() => pubsub.close());
    for (const target of createdDatabases)
      await clean(() =>
        postgres(target.originalUrl, (db) =>
          db.query(`DROP DATABASE "${target.name}" WITH (FORCE)`),
        ),
      );
    await clean(() => rm(directory, { recursive: true, force: true }));
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [operationError, ...cleanupErrors] : cleanupErrors,
      'Isolated rehearsal cleanup failed',
    );
  if (failed) throw operationError;
  return report!;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv.includes('--run')) {
    console.log(
      'Use --run with six TEST_*_DATABASE_URL values, TEST_REDIS_URL and a loopback Pub/Sub emulator. This creates and removes isolated rehearsal resources only.',
    );
  } else {
    rehearseDevelopmentReset()
      .then((report) => console.log(JSON.stringify(report)))
      .catch(() => {
        console.error(
          'Isolated reset rehearsal failed; inspect test service availability and rehearsal diagnostics',
        );
        process.exitCode = 1;
      });
  }
}
