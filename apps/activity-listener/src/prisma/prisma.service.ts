import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createRequire } from 'node:module';
import type { PrismaClient as GeneratedActivityClient } from '.prisma/activity-client';
import { activityRegistryConfig } from '../config/activity-registry.config.js';

const ActivityClient = createRequire(import.meta.url)('.prisma/activity-client')
  .PrismaClient as new (
  ...args: ConstructorParameters<typeof GeneratedActivityClient>
) => GeneratedActivityClient;

@Injectable()
export class ActivityPrismaService
  extends ActivityClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(activityRegistryConfig.KEY)
    config: Pick<ConfigType<typeof activityRegistryConfig>, 'databaseUrl'>,
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
