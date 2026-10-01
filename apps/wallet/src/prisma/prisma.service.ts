import { walletConfig } from '../config/wallet.config';
import { ConfigType } from '@nestjs/config';
import { Inject, Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
export class WalletPrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(walletConfig.KEY) config: Pick<ConfigType<typeof walletConfig>, 'databaseUrl'>,
  ) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: 10,
        connectionTimeoutMillis: 5000,
        options: '-c timezone=UTC',
      }),
      transactionOptions: { maxWait: 10000, timeout: 10000 },
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
