import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { ExchangeMessagingService } from './exchange-messaging.service.js';

@Module({
  imports: [MessagingModule, WalletPrismaModule],
  providers: [ExchangeMessagingService],
  exports: [ExchangeMessagingService],
})
export class ExchangeMessagingModule {}
