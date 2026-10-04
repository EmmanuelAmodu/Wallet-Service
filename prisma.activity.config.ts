import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'apps/activity-listener/prisma/schema.prisma',
  migrations: { path: 'apps/activity-listener/prisma/migrations' },
  datasource: {
    url: process.env.ACTIVITY_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  },
});
