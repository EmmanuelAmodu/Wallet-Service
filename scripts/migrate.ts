import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { required } from '../packages/shared/src/config.js';

type Application = 'wallet' | 'broadcast' | 'ledger' | 'activity' | 'user' | 'sweep';
const applications: Record<Application, { config: string; env: string; local?: string }> = {
  wallet: { config: 'prisma.config.ts', env: 'WALLET_DATABASE_URL' },
  broadcast: { config: 'prisma.broadcast.config.ts', env: 'BROADCAST_DATABASE_URL' },
  ledger: {
    config: 'prisma.ledger.config.ts',
    env: 'LEDGER_DATABASE_URL',
    local: 'postgresql://ledger:ledger_local_only@127.0.0.1:5434/ledger',
  },
  activity: {
    config: 'prisma.activity.config.ts',
    env: 'ACTIVITY_DATABASE_URL',
    local: 'postgresql://activity:activity_local_only@127.0.0.1:5435/activity',
  },
  sweep: {
    config: 'prisma.sweep.config.ts',
    env: 'SWEEP_DATABASE_URL',
    local: 'postgresql://sweep:sweep_local_only@127.0.0.1:5436/sweep',
  },
  user: {
    config: 'prisma.user.config.ts',
    env: 'USER_DATABASE_URL',
    local: 'postgresql://users:users_local_only@127.0.0.1:5437/users',
  },
};

export async function migrate(url: string, application: Application = 'wallet') {
  run(['migrate', 'deploy', '--config', applications[application].config], url, application);
}

function run(args: string[], url: string, application: Application = 'wallet') {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), ...args],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        [applications[application].env]: url,
      },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) throw new Error('Prisma migration command failed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const application = process.argv[2];
  const runMigrations = async () => {
    if (application && !Object.hasOwn(applications, application))
      throw new Error('Expected wallet, broadcast, ledger, activity, user, or sweep');
    for (const name of Object.keys(applications) as Application[]) {
      if (application && application !== name) continue;
      const target = applications[name];
      const url =
        process.env[target.env] ??
        (process.env.NODE_ENV !== 'production' ? target.local : undefined) ??
        required(target.env);
      await migrate(url, name);
    }
  };
  runMigrations().catch(() => {
    console.error('Migration failed; inspect Prisma diagnostics and application database URLs');
    process.exitCode = 1;
  });
}
