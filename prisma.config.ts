import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: 'apps/wallet/prisma/schema.prisma',
  migrations: { path: 'apps/wallet/prisma/migrations' },
  datasource: {
    url:
      process.env.WALLET_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://unused:unused@localhost:5432/unused',
  },
});
