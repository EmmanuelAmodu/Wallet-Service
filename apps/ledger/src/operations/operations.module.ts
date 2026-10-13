import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { ReconciliationService } from './reconciliation.service.js';
@Module({
  imports: [LedgerPrismaModule, ReservationsModule],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class LedgerOperationsModule {}
