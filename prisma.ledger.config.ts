import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'apps/ledger/prisma/schema.prisma',
  migrations: { path: 'apps/ledger/prisma/migrations' },
  datasource: {
    url: process.env.LEDGER_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  },
});