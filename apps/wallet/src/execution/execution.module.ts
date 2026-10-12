import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { CustodyModule } from '../custody/custody.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { executionConfig } from '../config/execution.config.js';
import { TokenFeesService } from './token-fees.service.js';
import { CustodyExecutionService } from './execution.service.js';
@Module({
  imports: [
    WalletPrismaModule,
    CustodyModule,
    ChainModule,
    MessagingModule,
    ConfigModule.forFeature(executionConfig),
  ],
  providers: [CustodyExecutionService, TokenFeesService],
  exports: [CustodyExecutionService, TokenFeesService],
})
export class ExecutionModule {}
