import { ExecutionModule } from '../execution/execution.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { CustodyModule } from '../custody/custody.module.js';
import { customerAuthConfig } from '../config/customer-auth.config.js';
import { CustomerAuthGuard } from '../auth/customer-auth.guard.js';
import { ExchangeMessagingModule } from '../exchange-messaging/exchange-messaging.module.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { executionConfig } from '../config/execution.config.js';
import { WithdrawalsService } from './withdrawals.service.js';
import { WithdrawalsController } from './withdrawals.controller.js';
@Module({
  imports: [
    ExecutionModule,
    WalletPrismaModule,
    CustodyModule,
    ExchangeMessagingModule,
    MessagingModule,
    ConfigModule.forFeature(executionConfig),
    ConfigModule.forFeature(customerAuthConfig),
  ],
  providers: [WithdrawalsService, CustomerAuthGuard],
  controllers: [WithdrawalsController],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
