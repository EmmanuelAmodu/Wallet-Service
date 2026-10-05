import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'apps/sweep/prisma/schema.prisma',
  migrations: { path: 'apps/sweep/prisma/migrations' },
  datasource: {
    url: process.env.SWEEP_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  },
});
