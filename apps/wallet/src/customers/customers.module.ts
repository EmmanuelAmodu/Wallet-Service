import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { exchangeApiConfig } from '../config/exchange-api.config.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { LedgerClientModule } from '../ledger/ledger-client.module.js';
import { ExchangeCustomersController } from './customers.controller.js';
import { ExchangeCustomersService } from './customers.service.js';
import { ExchangeBackendGuard } from './exchange-backend.guard.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';

@Module({
  imports: [
    ConfigModule.forFeature(exchangeApiConfig),
    MessagingModule,
    WalletPrismaModule,
    LedgerClientModule,
  ],
  controllers: [ExchangeCustomersController],
  providers: [ExchangeCustomersService, ExchangeBackendGuard],
  exports: [ExchangeCustomersService, ExchangeBackendGuard],
})
export class CustomersModule {}
