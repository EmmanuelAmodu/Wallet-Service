import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { WalletProcessor } from './wallet.processor.js';
import { WalletWorkflowService } from './wallet-workflow.service.js';
import { ExchangeMessagingModule } from '../exchange-messaging/exchange-messaging.module.js';
@Module({
  imports: [MessagingModule, WalletPrismaModule, ChainModule, ExchangeMessagingModule],
  providers: [WalletProcessor, WalletWorkflowService],
})
export class WalletMessagingModule {}
