import { broadcastConfig } from '../config/broadcast.config.js';
import { ConfigType } from '@nestjs/config';
import { Inject, Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { createRequire } from 'node:module';
import type { PrismaClient as BroadcastPrismaClient } from '.prisma/broadcast-client';
import { PrismaPg } from '@prisma/adapter-pg';

const PrismaClient = createRequire(import.meta.url)('.prisma/broadcast-client')
  .PrismaClient as new (
  ...args: ConstructorParameters<typeof BroadcastPrismaClient>
) => BroadcastPrismaClient;

@Injectable()
export class BroadcastPrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(broadcastConfig.KEY) config: Pick<ConfigType<typeof broadcastConfig>, 'databaseUrl'>,
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
