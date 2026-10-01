import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createDatabase } from '../packages/database/src/client';
import { required } from '../packages/shared/src/http';

export async function migrate(url: string) {
  const db = createDatabase(url);
  try {
    // The original SQL runner recorded 001_initial.sql. Baseline only that known schema.
    const [tables] = await db.$queryRaw<
      { legacy: string | null; prisma: string | null }[]
    >`SELECT to_regclass('public.schema_migrations')::text AS legacy,to_regclass('public._prisma_migrations')::text AS prisma`;
    if (tables.legacy && !tables.prisma) {
      const applied = await db.$queryRaw<{ name: string }[]>`SELECT name FROM schema_migrations`;
      if (applied.length !== 1 || applied[0].name !== '001_initial.sql')
        throw new Error('Unrecognized legacy schema; baseline manually');
      run(['migrate', 'resolve', '--applied', '0001_initial'], url);
    }
    run(['migrate', 'deploy'], url);
  } finally {
    await db.$disconnect();
  }
}
function run(args: string[], url: string) {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), ...args],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('Prisma migration command failed');
}
if (require.main === module)
  migrate(required('DATABASE_URL')).catch(() => {
    console.error('Migration failed; inspect Prisma diagnostics');
    process.exitCode = 1;
  });
