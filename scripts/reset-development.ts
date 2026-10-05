import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PubSub } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { connection } from '../packages/queue/src/messaging.module.js';
import { QUEUES } from '../packages/queue/src/messages.js';
import { epochQueuePrefix } from '../packages/queue/src/queue.config.js';
import {
  acquireDevelopmentResetLock,
  dotenvAssignmentSpans,
  readResetEnvironment,
  resetEnvironmentPath,
} from '../packages/shared/src/development-reset.js';

const databaseTargets = [
  { name: 'wallet', envName: 'WALLET_DATABASE_URL', config: 'prisma.config.ts' },
  {
    name: 'broadcast',
    envName: 'BROADCAST_DATABASE_URL',
    config: 'prisma.broadcast.config.ts',
  },
  { name: 'ledger', envName: 'LEDGER_DATABASE_URL', config: 'prisma.ledger.config.ts' },
  { name: 'activity', envName: 'ACTIVITY_DATABASE_URL', config: 'prisma.activity.config.ts' },
  { name: 'sweep', envName: 'SWEEP_DATABASE_URL', config: 'prisma.sweep.config.ts' },
  { name: 'user', envName: 'USER_DATABASE_URL', config: 'prisma.user.config.ts' },
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
  if (url.search || url.hash || !/^\/?[0-9]*$/.test(url.pathname))
    throw new Error('Development reset refuses Redis URL overrides or invalid database paths');
  return value;
}

export function localPubSubEndpoint(value: string) {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname))
    throw new Error('Development reset only accepts a loopback Pub/Sub emulator');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Development reset refuses Pub/Sub endpoint overrides or paths');
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
  epochQueuePrefix(input.basePrefix, input.resetEpoch ?? 'validation');
  if (
    input.currentSubscription &&
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,254}$/.test(input.currentSubscription)
  )
    throw new Error('Invalid current Pub/Sub subscription name');
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
    const retired = input.previousQueuePrefix;
    if (retired !== input.basePrefix) {
      const expectedPrefix = `${input.basePrefix}:`;
      if (!retired.startsWith(expectedPrefix))
        throw new Error('Persisted retired queue belongs to another project prefix');
      const retiredEpoch = retired.slice(expectedPrefix.length);
      epochQueuePrefix(input.basePrefix, retiredEpoch);
      if (retiredEpoch === resetEpoch)
        throw new Error('Persisted retired queue cannot be the current reset namespace');
    }
    if (
      input.currentTopic !== epochResourceName(input.topicBase, resetEpoch) ||
      input.currentSubscription !== epochResourceName(input.subscriptionBase, resetEpoch)
    )
      throw new Error('Persisted Pub/Sub replacement namespace does not match the reset epoch');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,254}$/.test(input.previousSubscription))
      throw new Error('Invalid persisted Pub/Sub subscription name');
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
  const assignments = dotenvAssignmentSpans(normalized);
  const replacements: { startLine: number; endLine: number; line: string }[] = [];
  const additions: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value))
      throw new Error('Invalid environment entry');
    const matching = assignments.filter((assignment) => assignment.key === key);
    if (matching.length > 1) throw new Error(`Duplicate ${key} in .env`);
    if (matching.length) replacements.push({ ...matching[0], line: `${key}=${value}` });
    else additions.push(`${key}=${value}`);
  }
  for (const { startLine, endLine, line } of replacements.sort((a, b) => b.startLine - a.startLine))
    lines.splice(startLine, endLine - startLine + 1, line);
  lines.push(...additions);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function resetDatabase(
  name: string,
  envName: string,
  config: string,
  connectionString: string,
  environment: NodeJS.ProcessEnv,
) {
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
      env: postgresResetEnvironment(connectionString, envName, environment),
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

async function writeEnvironment(envPath: string, values: Record<string, string>) {
  const content = await readFile(envPath, 'utf8');
  const next = updateEnvContent(content, values);
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(next, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, envPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function developmentResetConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.NODE_ENV === 'production')
    throw new Error('Development reset is disabled in production');
  const urls = databaseTargets.map((target) => {
    const url = environment[target.envName];
    if (!url) throw new Error(`Missing configuration: ${target.envName}`);
    return { ...target, url, database: localDatabaseName(url) };
  });
  const identities = new Set<string>();
  for (const target of urls) {
    const url = new URL(target.url);
    // Loopback aliases can refer to the same server: ownership must still be distinct.
    const identity = `${url.port || '5432'}:${target.database}`;
    if (identities.has(identity))
      throw new Error('Development reset requires six distinct owned service databases');
    identities.add(identity);
  }
  if (!environment.REDIS_URL) throw new Error('Missing configuration: REDIS_URL');
  return {
    urls,
    redisUrl: localRedisUrl(environment.REDIS_URL),
    apiEndpoint: localPubSubEndpoint(environment.PUBSUB_API_ENDPOINT ?? '127.0.0.1:8086'),
    projectId: environment.PUBSUB_PROJECT_ID ?? 'wallet-local',
  };
}

export type DevelopmentResetStep =
  | 'pubsub-created'
  | `database:${(typeof databaseTargets)[number]['name']}`
  | 'queues-retired'
  | 'subscription-retired';

// The CLI and isolated rehearsal execute exactly the same destructive sequence.
// A failing hook retains the durable epoch/fence so the same operation can resume.
export async function performDevelopmentReset(
  environment: NodeJS.ProcessEnv,
  plan: DevelopmentResetPlan,
  afterStep?: (step: DevelopmentResetStep) => Promise<void> | void,
) {
  const { urls, redisUrl, apiEndpoint, projectId } = developmentResetConfiguration(environment);
  await ensurePubSubNamespace(projectId, apiEndpoint, plan.topic, plan.subscription);
  await afterStep?.('pubsub-created');
  for (const target of urls) {
    resetDatabase(target.name, target.envName, target.config, target.url, environment);
    await afterStep?.(`database:${target.name}`);
  }
  await resetQueues(redisUrl, plan.retiredQueuePrefix);
  await afterStep?.('queues-retired');
  await retirePubSubSubscription(
    projectId,
    apiEndpoint,
    plan.previousSubscription,
    plan.subscription,
  );
  await afterStep?.('subscription-retired');
}

function persistedPlan(environment: NodeJS.ProcessEnv, resume: boolean) {
  return createDevelopmentResetPlan({
    resume,
    resetEpoch: environment.RESET_EPOCH,
    resetInProgress: environment.RESET_IN_PROGRESS,
    previousQueuePrefix: environment.RESET_PREVIOUS_QUEUE_PREFIX,
    previousSubscription: environment.RESET_PREVIOUS_SUBSCRIPTION,
    currentTopic: environment.PUBSUB_TOPIC,
    currentSubscription: environment.PUBSUB_SUBSCRIPTION,
    basePrefix: environment.QUEUE_PREFIX ?? 'waas',
    topicBase: environment.PUBSUB_TOPIC_BASE ?? 'on-chain-activity',
    subscriptionBase: environment.PUBSUB_SUBSCRIPTION_BASE ?? 'wallet-activity',
  });
}

export async function runDevelopmentReset(options: {
  envPath: string;
  environment?: NodeJS.ProcessEnv;
  resume?: boolean;
  prepare?: (environment: NodeJS.ProcessEnv, plan: DevelopmentResetPlan) => void;
  performReset: (environment: NodeJS.ProcessEnv, plan: DevelopmentResetPlan) => Promise<void>;
}) {
  const envPath = resetEnvironmentPath({ RESET_ENV_FILE: options.envPath });
  const lock = await acquireDevelopmentResetLock(envPath);
  try {
    const inherited = options.environment ?? process.env;
    if (inherited.NODE_ENV === 'production')
      throw new Error('Development reset is disabled in production');
    // Reset control and recovery targets come from disk, not a shell's cached dotenv exports.
    const environment = { ...inherited, ...readResetEnvironment(envPath) };
    if (environment.NODE_ENV === 'production')
      throw new Error('Development reset is disabled in production');
    const plan = persistedPlan(environment, options.resume ?? false);
    options.prepare?.(environment, plan);
    await lock.assertOwned();
    const activeEnvironment = {
      ...environment,
      RESET_IN_PROGRESS: plan.resetEpoch,
      RESET_EPOCH: plan.resetEpoch,
      RESET_PREVIOUS_QUEUE_PREFIX: plan.retiredQueuePrefix,
      RESET_PREVIOUS_SUBSCRIPTION: plan.previousSubscription,
      PUBSUB_TOPIC: plan.topic,
      PUBSUB_SUBSCRIPTION: plan.subscription,
    };
    if (!options.resume) {
      await writeEnvironment(envPath, {
        RESET_IN_PROGRESS: plan.resetEpoch,
        RESET_EPOCH: plan.resetEpoch,
        RESET_PREVIOUS_QUEUE_PREFIX: plan.retiredQueuePrefix,
        RESET_PREVIOUS_SUBSCRIPTION: plan.previousSubscription,
        PUBSUB_TOPIC: plan.topic,
        PUBSUB_SUBSCRIPTION: plan.subscription,
      });
    }
    await lock.assertOwned();
    const fenced = readResetEnvironment(envPath);
    if (fenced.RESET_EPOCH !== plan.resetEpoch || fenced.RESET_IN_PROGRESS !== plan.resetEpoch)
      throw new Error('Durable reset fence is missing or changed; refusing to perform the reset');
    await options.performReset(activeEnvironment, plan);
    await lock.assertOwned();
    const persisted = readResetEnvironment(envPath);
    if (
      persisted.RESET_EPOCH !== plan.resetEpoch ||
      persisted.RESET_IN_PROGRESS !== plan.resetEpoch
    )
      throw new Error('Reset ownership changed; refusing to clear another reset fence');
    await writeEnvironment(envPath, {
      RESET_IN_PROGRESS: '',
      RESET_PREVIOUS_QUEUE_PREFIX: '',
      RESET_PREVIOUS_SUBSCRIPTION: '',
    });
    return plan;
  } finally {
    await lock.release();
  }
}

function printPreview(environment: NodeJS.ProcessEnv, plan: DevelopmentResetPlan) {
  const { urls } = developmentResetConfiguration(environment);
  const { resetEpoch, retiredQueuePrefix, previousSubscription, topic, subscription } = plan;
  console.log('Development reset preview:');
  console.log(`- Databases: ${urls.map(({ name, database }) => `${name}/${database}`).join(', ')}`);
  console.log(`- Retired BullMQ prefix: ${retiredQueuePrefix}`);
  console.log(
    `- New BullMQ prefix: ${epochQueuePrefix(environment.QUEUE_PREFIX ?? 'waas', resetEpoch)}`,
  );
  console.log(
    `- New Pub/Sub namespace: ${environment.PUBSUB_PROJECT_ID ?? 'wallet-local'}/${topic} -> ${subscription}`,
  );
  console.log(`- Retired Pub/Sub subscription: ${previousSubscription}`);
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
  const envPath = resetEnvironmentPath();
  const resume = flags.has('--resume');
  if (!flags.has('--apply')) {
    const lock = await acquireDevelopmentResetLock(envPath);
    try {
      const environment = { ...process.env, ...readResetEnvironment(envPath) };
      printPreview(environment, persistedPlan(environment, resume));
      console.log(
        'No changes made. Stop workers/publisher and remove provider watches before applying.',
      );
    } finally {
      await lock.release();
    }
    return;
  }
  for (const acknowledgement of [
    '--workers-stopped',
    '--publisher-stopped',
    '--provider-watches-removed',
  ])
    if (!flags.has(acknowledgement))
      throw new Error(`Applying the reset requires ${acknowledgement}`);

  const plan = await runDevelopmentReset({
    envPath,
    resume,
    prepare: printPreview,
    performReset: performDevelopmentReset,
  });
  const { resetEpoch, topic } = plan;
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
