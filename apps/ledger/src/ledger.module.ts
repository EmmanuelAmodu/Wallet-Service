import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../packages/queue/src/messaging.module.js';
import { LedgerPrismaModule } from './prisma/prisma.module.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerAuthGuard } from './ledger-auth.guard.js';
import { LedgerProcessor } from './ledger.processor.js';
import { LedgerService } from './ledger.service.js';
import { OutboxModule } from '../../../packages/queue/src/outbox.module.js';
import { LedgerPrismaService } from './prisma/prisma.service.js';
import { LedgerExchangeModule } from './exchange/exchange.module.js';

@Module({
  imports: [
    LedgerPrismaModule,
    MessagingModule,
    LedgerExchangeModule,
    OutboxModule.register(LedgerPrismaModule, LedgerPrismaService),
  ],
  controllers: [LedgerController],
  providers: [LedgerAuthGuard, LedgerProcessor, LedgerService],
})
export class LedgerModule {}
