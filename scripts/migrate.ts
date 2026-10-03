import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { required } from '../packages/shared/src/config.js';

export async function migrate(
  url: string,
  application: 'wallet' | 'broadcast' | 'ledger' = 'wallet',
) {
  const config =
    application === 'wallet'
      ? 'prisma.config.ts'
      : application === 'broadcast'
        ? 'prisma.broadcast.config.ts'
        : 'prisma.ledger.config.ts';
  run(['migrate', 'deploy', '--config', config], url, application);
}

function run(
  args: string[],
  url: string,
  application: 'wallet' | 'broadcast' | 'ledger' = 'wallet',
) {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), ...args],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        ...(application === 'wallet' ? { WALLET_DATABASE_URL: url } : {}),
        ...(application === 'broadcast' ? { BROADCAST_DATABASE_URL: url } : {}),
        ...(application === 'ledger' ? { LEDGER_DATABASE_URL: url } : {}),
      },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) throw new Error('Prisma migration command failed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const application = process.argv[2];
  const runMigrations = async () => {
    if (
      application &&
      application !== 'wallet' &&
      application !== 'broadcast' &&
      application !== 'ledger'
    )
      throw new Error('Expected wallet, broadcast, or ledger');
    if (!application || application === 'wallet') await migrate(required('WALLET_DATABASE_URL'));
    if (!application || application === 'broadcast')
      await migrate(required('BROADCAST_DATABASE_URL'), 'broadcast');
    if (!application || application === 'ledger')
      await migrate(
        process.env.LEDGER_DATABASE_URL ??
          (process.env.NODE_ENV === 'production'
            ? required('LEDGER_DATABASE_URL')
            : 'postgresql://ledger:ledger_local_only@127.0.0.1:5434/ledger'),
        'ledger',
      );
  };
  runMigrations().catch(() => {
    console.error('Migration failed; inspect Prisma diagnostics and application database URLs');
    process.exitCode = 1;
  });
}
