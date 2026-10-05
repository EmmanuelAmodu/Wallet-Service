import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createRequire } from 'node:module';
import type { PrismaClient as GeneratedUserClient } from '.prisma/user-client';
import { userConfig } from '../config/user.config.js';

const UserClient = createRequire(import.meta.url)('.prisma/user-client').PrismaClient as new (
  ...args: ConstructorParameters<typeof GeneratedUserClient>
) => GeneratedUserClient;

@Injectable()
export class UserPrismaService extends UserClient implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(userConfig.KEY) config: Pick<ConfigType<typeof userConfig>, 'databaseUrl'>) {
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
