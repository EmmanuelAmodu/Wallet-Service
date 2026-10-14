import { rolloutConfig } from '../../../packages/shared/src/rollout.config.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { walletConfig } from './config/wallet.config.js';
import { networkConfig } from '../../../packages/chain/src/config.js';
import { OutboxModule } from '../../../packages/queue/src/outbox.module.js';
import { WalletPrismaModule } from './prisma/prisma.module.js';
import { WalletPrismaService } from './prisma/prisma.service.js';
import { APP_FILTER } from '@nestjs/core';
import { SafeErrorsFilter } from '../../../packages/shared/src/http/safe-errors.filter.js';
import { AuthModule } from './auth/auth.module.js';
import { WalletsModule } from './wallets/wallets.module.js';
import { TransactionsModule } from './transactions/transactions.module.js';
import { WalletMessagingModule } from './messaging/wallet-messaging.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { CustodyApiModule } from './custody-api/custody-api.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [rolloutConfig, queueConfig, walletConfig, networkConfig],
    }),
    OutboxModule.register(WalletPrismaModule, WalletPrismaService),
    AuthModule,
    WalletsModule,
    TransactionsModule,
    WalletMessagingModule,
    CustomersModule,
    CustodyApiModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeErrorsFilter }],
})
export class AppModule {}
