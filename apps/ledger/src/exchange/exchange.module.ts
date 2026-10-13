import { LedgerOperationsModule } from '../operations/operations.module.js';
import { Module } from '@nestjs/common';
import { LedgerPrismaModule } from '../prisma/prisma.module.js';
import { DepositsModule } from '../deposits/deposits.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SettlementsModule } from '../settlements/settlements.module.js';
import { LedgerAuthGuard } from '../ledger-auth.guard.js';
import { LedgerExchangeController } from './exchange.controller.js';
import { LedgerExchangeService } from './exchange.service.js';
import { ExchangeRegistryService } from './registry.service.js';
import { IncidentsModule } from '../incidents/incidents.module.js';

@Module({
  imports: [
    LedgerPrismaModule,
    LedgerOperationsModule,
    DepositsModule,
    ReservationsModule,
    SettlementsModule,
    IncidentsModule,
  ],
  controllers: [LedgerExchangeController],
  providers: [LedgerAuthGuard, LedgerExchangeService, ExchangeRegistryService],
  exports: [LedgerExchangeService],
})
export class LedgerExchangeModule {}
