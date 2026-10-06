import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { WalletProcessor } from './wallet.processor.js';
import { WalletWorkflowService } from './wallet-workflow.service.js';
import { ExchangeMessagingModule } from '../exchange-messaging/exchange-messaging.module.js';
import { CustodyModule } from '../custody/custody.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
@Module({
  imports: [
    MessagingModule,
    WalletPrismaModule,
    ChainModule,
    ExchangeMessagingModule,
    CustodyModule,
    CustomersModule,
    ExecutionModule,
  ],
  providers: [WalletProcessor, WalletWorkflowService],
})
export class WalletMessagingModule {}
