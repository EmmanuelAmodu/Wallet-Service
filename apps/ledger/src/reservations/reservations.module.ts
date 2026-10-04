import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [LedgerPrismaModule, JournalModule],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
