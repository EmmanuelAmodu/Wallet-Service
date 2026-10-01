import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { required } from '../../shared/src/http';

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
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: required('DATABASE_URL'),
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
export type DbTransaction = Prisma.TransactionClient;
export async function lock(db: DbTransaction, key: string) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export async function lockTransaction(db: DbTransaction, id: string) {
  await db.$queryRaw`SELECT id FROM transactions WHERE id=${id}::uuid FOR UPDATE`;
}
