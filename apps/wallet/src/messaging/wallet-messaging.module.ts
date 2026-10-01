import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module';
import { ChainModule } from '../../../../packages/chain/src/chain.module';
import { WalletPrismaModule } from '../prisma/prisma.module';
import { WalletProcessor } from './wallet.processor';
import { WalletWorkflowService } from './wallet-workflow.service';
@Module({
  imports: [MessagingModule, WalletPrismaModule, ChainModule],
  providers: [WalletProcessor, WalletWorkflowService],
})
export class WalletMessagingModule {}
