import { Injectable } from '@nestjs/common';
import { PrismaClient } from '.prisma/broadcast-client';
import { PrismaPg } from '@prisma/adapter-pg';
import { required } from '../../../packages/shared/src/http';

@Injectable()
export class BroadcastDatabase extends PrismaClient {
  constructor(url = required('BROADCAST_DATABASE_URL')) {
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
