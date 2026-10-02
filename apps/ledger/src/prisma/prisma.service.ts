import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { createRequire } from 'node:module';
import { ledgerConfig } from '../config/ledger.config.js';
import type { PrismaClient as GeneratedLedgerClient } from '.prisma/ledger-client';

const LedgerClient = createRequire(import.meta.url)('.prisma/ledger-client').PrismaClient as new (
  ...args: ConstructorParameters<typeof GeneratedLedgerClient>
) => GeneratedLedgerClient;

@Injectable()
export class LedgerPrismaService
  extends LedgerClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(ledgerConfig.KEY) config: Pick<ConfigType<typeof ledgerConfig>, 'databaseUrl'>,
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
