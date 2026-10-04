import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SettlementsService } from './settlements.service.js';

@Module({
  imports: [LedgerPrismaModule, JournalModule, ReservationsModule],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
