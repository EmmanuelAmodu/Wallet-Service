import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { required } from '../../../packages/shared/src/http';

// Prisma's pg adapter requires UTC sessions for correct TIMESTAMPTZ serialization.
export function createDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      options: '-c timezone=UTC',
    }),
    transactionOptions: { maxWait: 10000, timeout: 10000 },
  });
}
@Injectable()
export class Database extends PrismaClient implements OnApplicationShutdown {
  constructor(url = required('WALLET_DATABASE_URL')) {
    super({
      adapter: new PrismaPg({
        connectionString: url,
        max: 10,
        connectionTimeoutMillis: 5000,
        options: '-c timezone=UTC',
      }),
      transactionOptions: { maxWait: 10000, timeout: 10000 },
    });
  }
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
