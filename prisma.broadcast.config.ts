import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: 'apps/broadcast/prisma/schema.prisma',
  migrations: { path: 'apps/broadcast/prisma/migrations' },
  datasource: {
    url: process.env.BROADCAST_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  },
});
