import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config';
import { walletConfig } from './config/wallet.config';
import { networkConfig } from '../../../packages/chain/src/config';
import { OutboxModule } from '../../../packages/queue/src/outbox.module';
import { WalletPrismaModule } from './prisma/prisma.module';
import { WalletPrismaService } from './prisma/prisma.service';
import { APP_FILTER } from '@nestjs/core';
import { SafeErrorsFilter } from '../../../packages/shared/src/http/safe-errors.filter';
import { AuthModule } from './auth/auth.module';
import { WalletsModule } from './wallets/wallets.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WalletMessagingModule } from './messaging/wallet-messaging.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [queueConfig, walletConfig, networkConfig],
    }),
    OutboxModule.register(WalletPrismaModule, WalletPrismaService),
    AuthModule,
    WalletsModule,
    TransactionsModule,
    WalletMessagingModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SafeErrorsFilter }],
})
export class AppModule {}
