import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';
import { operationsConfig } from '../config/operations.config.js';
import { OperationsService } from './operations.service.js';
import { OperationsController, OperationsGuard } from './operations.controller.js';
@Module({
  imports: [
    WalletPrismaModule,
    ChainModule,
    MessagingModule,
    ExecutionModule,
    WithdrawalsModule,
    ConfigModule.forFeature(operationsConfig),
  ],
  providers: [OperationsService, OperationsGuard],
  controllers: [OperationsController],
  exports: [OperationsService],
})
export class OperationsModule {}
