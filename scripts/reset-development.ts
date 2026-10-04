import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PubSub } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { connection } from '../packages/queue/src/messaging.module.js';
import { QUEUES } from '../packages/queue/src/messages.js';
import { epochQueuePrefix } from '../packages/queue/src/queue.config.js';
import { required } from '../packages/shared/src/config.js';

const databaseTargets = [
  { name: 'wallet', envName: 'WALLET_DATABASE_URL', config: 'prisma.config.ts' },
  {
    name: 'broadcast',
    envName: 'BROADCAST_DATABASE_URL',
    config: 'prisma.broadcast.config.ts',
  },
  { name: 'ledger', envName: 'LEDGER_DATABASE_URL', config: 'prisma.ledger.config.ts' },
] as const;

function isLoopback(hostname: string) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
}

export function localDatabaseName(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !isLoopback(url.hostname))
    throw new Error('Development reset only accepts loopback PostgreSQL URLs');
  if (url.search || url.hash)
    throw new Error('Development reset refuses PostgreSQL URL overrides or fragments');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || ['postgres', 'template0', 'template1'].includes(name))
    throw new Error('Development reset refuses maintenance or template databases');
  return name;
}

export function postgresResetEnvironment(
  connectionString: string,
  envName: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
) {
  localDatabaseName(connectionString);
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    DATABASE_URL: connectionString,
    [envName]: connectionString,
  };
  for (const name of [
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGDATABASE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS',
    'PGUSER',
    'PGPASSWORD',
  ])
    delete environment[name];
  return environment;
}

export function localRedisUrl(value: string) {
  const url = new URL(value);
  if (!['redis:', 'rediss:'].includes(url.protocol) || !isLoopback(url.hostname))
    throw new Error('Development reset only accepts loopback Redis URLs');
  return value;
}

export function localPubSubEndpoint(value: string) {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (!isLoopback(url.hostname))
    throw new Error('Development reset only accepts a loopback Pub/Sub emulator');
  return url.toString();
}

export function epochResourceName(base: string, resetEpoch: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,180}$/.test(base))
    throw new Error('Invalid Pub/Sub resource base name');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resetEpoch)) throw new Error('Invalid reset epoch');
  return `${base}-${resetEpoch.slice(0, 8)}`;
}

export interface DevelopmentResetPlan {
  resetEpoch: string;
  retiredQueuePrefix: string;
  previousSubscription: string;
  topic: string;
  subscription: string;
}

export function createDevelopmentResetPlan(input: {
  resume: boolean;
  resetEpoch?: string;
  resetInProgress?: string;
  previousQueuePrefix?: string;
  previousSubscription?: string;
  currentSubscription?: string;
  currentTopic?: string;
  basePrefix: string;
  topicBase: string;
  subscriptionBase: string;
}): DevelopmentResetPlan {
  if (input.resetInProgress && !input.resume)
    throw new Error('A development reset is in progress; resume it before starting services');
  if (input.resume && !input.resetInProgress)
    throw new Error('There is no persisted reset to resume');
  if (input.resume && input.resetEpoch !== input.resetInProgress)
    throw new Error('Persisted reset epoch does not match RESET_EPOCH');

  const resetEpoch = input.resume ? input.resetInProgress! : randomUUID();
  if (input.resume) {
    if (
      !input.previousQueuePrefix ||
      !input.previousSubscription ||
      !input.currentTopic ||
      !input.currentSubscription
    )
      throw new Error('Persisted reset plan is incomplete; refusing to guess recovery targets');
    return {
      resetEpoch,
      retiredQueuePrefix: input.previousQueuePrefix,
      previousSubscription: input.previousSubscription,
      topic: input.currentTopic,
      subscription: input.currentSubscription,
    };
  }

  return {
    resetEpoch,
    retiredQueuePrefix: input.resetEpoch
      ? epochQueuePrefix(input.basePrefix, input.resetEpoch)
      : input.basePrefix,
    previousSubscription: input.currentSubscription ?? input.subscriptionBase,
    topic: epochResourceName(input.topicBase, resetEpoch),
    subscription: epochResourceName(input.subscriptionBase, resetEpoch),
  };
}

export function updateEnvContent(content: string, values: Record<string, string>) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = normalized ? normalized.split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value))
      throw new Error('Invalid environment entry');
    const matching = lines.flatMap((line, index) => (line.startsWith(`${key}=`) ? [index] : []));
    if (matching.length > 1) throw new Error(`Duplicate ${key} in .env`);
    if (matching.length) lines[matching[0]] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function resetDatabase(name: string, envName: string, config: string, connectionString: string) {
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/prisma/build/index.js'),
      'migrate',
      'reset',
      '--force',
      '--config',
      config,
    ],
    {
      env: postgresResetEnvironment(connectionString, envName),
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Failed to reset the ${name} database`);
}

async function resetQueues(redisUrl: string, prefix: string) {
  for (const name of Object.values(QUEUES)) {
    const queue = new Queue(name, { connection: connection(redisUrl), prefix });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}

async function ensurePubSubNamespace(
  projectId: string,
  apiEndpoint: string,
  topicName: string,
  subscriptionName: string,
) {
  const pubsub = new PubSub({ projectId, apiEndpoint });
  try {
    const topic = pubsub.topic(topicName);
    const [topicExists] = await topic.exists();
    if (!topicExists) await topic.create();
    const subscription = topic.subscription(subscriptionName);
    const [subscriptionExists] = await subscription.exists();
    if (!subscriptionExists) await topic.createSubscription(subscriptionName);
  } finally {
    await pubsub.close();
  }
}

async function retirePubSubSubscription(
  projectId: string,
  apiEndpoint: string,
  subscriptionName: string,
  replacementName: string,
) {
  if (!subscriptionName || subscriptionName === replacementName) return;
  const pubsub = new PubSub({ projectId, apiEndpoint });
  try {
    const subscription = pubsub.subscription(subscriptionName);
    const [exists] = await subscription.exists();
    if (exists) await subscription.delete();
  } finally {
    await pubsub.close();
  }
}

async function writeEnvironment(values: Record<string, string>) {
  const envPath = resolve('.env');
  const content = await readFile(envPath, 'utf8');
  const next = updateEnvContent(content, values);
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, next, { flag: 'wx', mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, envPath);
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.has('--help')) {
    console.log(
      'Usage: npm run reset:development [-- --apply --workers-stopped --publisher-stopped --provider-watches-removed] | npm run reset:development -- --resume --apply --workers-stopped --publisher-stopped --provider-watches-removed',
    );
    return;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development reset is disabled in production');
  const resume = flags.has('--resume');
  const inProgressEpoch = process.env.RESET_IN_PROGRESS;

  const urls = databaseTargets.map((target) => {
    const url =
      process.env[target.envName] ??
      (target.name === 'ledger' && process.env.NODE_ENV !== 'production'
        ? 'postgresql://ledger:ledger_local_only@127.0.0.1:5434/ledger'
        : required(target.envName));
    return { ...target, url, database: localDatabaseName(url) };
  });
  const redisUrl = localRedisUrl(required('REDIS_URL'));
  const apiEndpoint = localPubSubEndpoint(process.env.PUBSUB_API_ENDPOINT ?? '127.0.0.1:8086');
  const projectId = process.env.PUBSUB_PROJECT_ID ?? 'wallet-local';
  const basePrefix = process.env.QUEUE_PREFIX ?? 'waas';
  const currentEpoch = process.env.RESET_EPOCH;
  const topicBase = process.env.PUBSUB_TOPIC_BASE ?? 'on-chain-activity';
  const subscriptionBase = process.env.PUBSUB_SUBSCRIPTION_BASE ?? 'wallet-activity';
  const plan = createDevelopmentResetPlan({
    resume,
    resetEpoch: currentEpoch,
    resetInProgress: inProgressEpoch,
    previousQueuePrefix: process.env.RESET_PREVIOUS_QUEUE_PREFIX,
    previousSubscription: process.env.RESET_PREVIOUS_SUBSCRIPTION,
    currentTopic: process.env.PUBSUB_TOPIC,
    currentSubscription: process.env.PUBSUB_SUBSCRIPTION,
    basePrefix,
    topicBase,
    subscriptionBase,
  });
  const { resetEpoch, retiredQueuePrefix, previousSubscription, topic, subscription } = plan;

  console.log('Development reset preview:');
  console.log(`- Databases: ${urls.map(({ name, database }) => `${name}/${database}`).join(', ')}`);
  console.log(`- Retired BullMQ prefix: ${retiredQueuePrefix}`);
  console.log(`- New BullMQ prefix: ${epochQueuePrefix(basePrefix, resetEpoch)}`);
  console.log(`- New Pub/Sub namespace: ${projectId}/${topic} -> ${subscription}`);
  if (!flags.has('--apply')) {
    console.log(
      'No changes made. Stop workers/publisher and remove provider watches before applying.',
    );
    return;
  }
  for (const acknowledgement of [
    '--workers-stopped',
    '--publisher-stopped',
    '--provider-watches-removed',
  ])
    if (!flags.has(acknowledgement))
      throw new Error(`Applying the reset requires ${acknowledgement}`);

  if (!resume) {
    await writeEnvironment({
      RESET_IN_PROGRESS: resetEpoch,
      RESET_EPOCH: resetEpoch,
      RESET_PREVIOUS_QUEUE_PREFIX: retiredQueuePrefix,
      RESET_PREVIOUS_SUBSCRIPTION: previousSubscription,
      PUBSUB_TOPIC: topic,
      PUBSUB_SUBSCRIPTION: subscription,
    });
  }

  await ensurePubSubNamespace(projectId, apiEndpoint, topic, subscription);
  for (const target of urls) resetDatabase(target.name, target.envName, target.config, target.url);
  await resetQueues(redisUrl, retiredQueuePrefix);
  await retirePubSubSubscription(projectId, apiEndpoint, previousSubscription, subscription);
  await writeEnvironment({
    RESET_IN_PROGRESS: '',
    RESET_PREVIOUS_QUEUE_PREFIX: '',
    RESET_PREVIOUS_SUBSCRIPTION: '',
  });
  console.log(`Reset complete. RESET_EPOCH=${resetEpoch}`);
  console.log(`Configure the stopped provider publisher for ${topic} at epoch ${resetEpoch}.`);
  console.log(
    'Migrations are applied; bootstrap custody and verify watches before starting workers.',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Development reset failed');
    process.exitCode = 1;
  });
}
