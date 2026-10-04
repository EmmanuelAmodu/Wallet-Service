import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { IncidentsService } from './incidents.service.js';
@Module({
  imports: [LedgerPrismaModule, JournalModule],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
