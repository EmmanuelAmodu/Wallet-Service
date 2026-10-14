import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { migrate } from './migrate.js';

const targets = [
  ['wallet', 'TEST_DATABASE_URL', 'postgresql://wallet:wallet_local_only@127.0.0.1:5432/wallet'],
  [
    'broadcast',
    'TEST_BROADCAST_DATABASE_URL',
    'postgresql://broadcast:broadcast_local_only@127.0.0.1:5433/broadcast',
  ],
  [
    'ledger',
    'TEST_LEDGER_DATABASE_URL',
    'postgresql://ledger:ledger_local_only@127.0.0.1:5434/ledger',
  ],
  [
    'activity',
    'TEST_ACTIVITY_DATABASE_URL',
    'postgresql://activity:activity_local_only@127.0.0.1:5435/activity',
  ],
  ['sweep', 'TEST_SWEEP_DATABASE_URL', 'postgresql://sweep:sweep_local_only@127.0.0.1:5436/sweep'],
  ['user', 'TEST_USER_DATABASE_URL', 'postgresql://users:users_local_only@127.0.0.1:5437/users'],
] as const;
export function localAcceptanceUrl(value: string, protocol: 'postgresql:' | 'redis:') {
  const url = new URL(value);
  if (url.protocol !== protocol || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Acceptance infrastructure must be on loopback');
  if (protocol === 'redis:' && !/^\/(?:[1-9]|1[0-5])$/.test(url.pathname))
    throw new Error('Acceptance Redis needs a dedicated nonzero database');
  return url;
}
export function acceptanceCounts(tap: string) {
  const read = (name: string) =>
    Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
  const counts = {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
    cancelled: read('cancelled'),
  };
  if (
    !Number.isSafeInteger(counts.tests) ||
    counts.tests < 1 ||
    counts.pass !== counts.tests ||
    counts.fail !== 0 ||
    counts.skipped !== 0 ||
    counts.cancelled !== 0
  )
    throw new Error('Acceptance requires passing tests with no skipped or cancelled scenarios');
  return counts;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; output: string }>((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code: code ?? 1, output }));
  });
}

export async function exchangeAcceptance() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Use a disposable local acceptance environment');
  const configured = targets.map(([app, key, fallback]) => ({
    app,
    key,
    source: localAcceptanceUrl(process.env[key] ?? fallback, 'postgresql:').toString(),
  }));
  const redis = localAcceptanceUrl(
    process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15',
    'redis:',
  ).toString();
  const id = randomUUID().replaceAll('-', ''),
    folder = resolve('artifacts', 'acceptance', id);
  await mkdir(folder, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', TEST_REDIS_URL: redis };
  const databases: { source: string; name: string }[] = [];
  const startedAt = new Date().toISOString();
  let cleanupFailed: boolean;
  let result: Record<string, unknown> = {
    id,
    startedAt,
    status: 'failed',
    scope:
      'isolated PostgreSQL/Redis and deterministic RPC/provider fixtures; not live adapter certification',
  };
  try {
    for (const { app, key, source } of configured) {
      const name = `waas_acceptance_${app}_${id}`,
        admin = new Client({ connectionString: source });
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${name}"`);
        databases.push({ source, name });
      } finally {
        await admin.end();
      }
      const url = new URL(source);
      url.pathname = `/${name}`;
      env[key] = url.toString();
      await migrate(url.toString(), app);
    }
    const snapshot = async () => {
      const list = await run(
        'git',
        [
          'ls-files',
          '-co',
          '--exclude-standard',
          'apps',
          'packages',
          'scripts',
          'tests',
          'package.json',
          'package-lock.json',
          'tsconfig.json',
          'tsconfig.tools.json',
          'nest-cli.json',
          'eslint.config.mjs',
          'prisma*.config.ts',
        ],
        env,
      );
      if (list.code !== 0) throw new Error('Cannot capture acceptance source identity');
      const paths = [...new Set(list.output.trim().split('\n'))].filter(Boolean).sort(),
        hash = createHash('sha256');
      for (const file of paths) {
        const content = await readFile(file);
        hash.update(file + '\0' + content.length + '\0');
        hash.update(content);
      }
      return { paths, digest: hash.digest('hex') };
    };
    const source = await snapshot();
    for (const [label, args] of [
      ['build', ['run', 'build']],
      ['lint', ['run', 'lint']],
      ['format', ['run', 'format:check']],
    ] as const) {
      console.log(`Acceptance: ${label}`);
      const output = await run('npm', [...args], env);
      await writeFile(resolve(folder, `${label}.log`), output.output);
      if (output.code !== 0) throw new Error(`Acceptance ${label} failed; inspect its local log`);
    }
    const testFiles = source.paths
      .filter((p) => p.startsWith('tests/') && p.endsWith('.test.ts'))
      .map((p) => resolve('dist', p.replace(/\.ts$/, '.js')));
    const tests = await run(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-concurrency=1', ...testFiles],
      env,
    );
    await writeFile(resolve(folder, 'tests.log'), tests.output);
    if (tests.code !== 0) throw new Error('Acceptance tests failed; inspect the local test log');
    if ((await snapshot()).digest !== source.digest)
      throw new Error('Source changed during acceptance; rerun against a stable checkout');
    result = {
      ...result,
      status: 'passed',
      counts: acceptanceCounts(tests.output),
      sourceDigest: source.digest,
    };
  } finally {
    const cleanupFailures: string[] = [];
    for (const { source, name } of databases.reverse()) {
      const admin = new Client({ connectionString: source });
      try {
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch {
        cleanupFailures.push(name);
      } finally {
        await admin.end();
      }
    }
    cleanupFailed = cleanupFailures.length > 0;
    result = {
      ...result,
      ...(cleanupFailed ? { status: 'failed' } : {}),
      finishedAt: new Date().toISOString(),
      cleanupFailures,
    };
    await writeFile(resolve(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Acceptance evidence: ${folder}`);
  }
  if (cleanupFailed)
    throw new Error('Acceptance test database cleanup requires attention; see result.json');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  exchangeAcceptance().catch(() => {
    console.error('Acceptance failed; inspect the generated local evidence.');
    process.exitCode = 1;
  });
