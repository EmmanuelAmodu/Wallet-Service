import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { WalletProcessor } from './wallet.processor.js';
import { WalletWorkflowService } from './wallet-workflow.service.js';
@Module({
  imports: [MessagingModule, WalletPrismaModule, ChainModule],
  providers: [WalletProcessor, WalletWorkflowService],
})
export class WalletMessagingModule {}
