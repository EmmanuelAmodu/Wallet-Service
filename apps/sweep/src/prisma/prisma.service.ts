import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createRequire } from 'node:module';
import type { PrismaClient as GeneratedSweepClient } from '.prisma/sweep-client';
import { sweepConfig } from '../config/sweep.config.js';

const SweepClient = createRequire(import.meta.url)('.prisma/sweep-client').PrismaClient as new (
  ...args: ConstructorParameters<typeof GeneratedSweepClient>
) => GeneratedSweepClient;

@Injectable()
export class SweepPrismaService extends SweepClient implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(sweepConfig.KEY) config: Pick<ConfigType<typeof sweepConfig>, 'databaseUrl'>,
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
