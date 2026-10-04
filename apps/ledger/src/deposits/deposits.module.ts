import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { DepositsService } from './deposits.service.js';

@Module({
  imports: [LedgerPrismaModule, JournalModule],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
