import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'apps/user/prisma/schema.prisma',
  migrations: { path: 'apps/user/prisma/migrations' },
  datasource: {
    url: process.env.USER_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  },
});
