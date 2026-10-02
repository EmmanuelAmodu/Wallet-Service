import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../packages/queue/src/messaging.module.js';
import { LedgerPrismaModule } from './prisma/prisma.module.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerAuthGuard } from './ledger-auth.guard.js';
import { LedgerProcessor } from './ledger.processor.js';
import { LedgerService } from './ledger.service.js';

@Module({
  imports: [LedgerPrismaModule, MessagingModule],
  controllers: [LedgerController],
  providers: [LedgerAuthGuard, LedgerProcessor, LedgerService],
})
export class LedgerModule {}
