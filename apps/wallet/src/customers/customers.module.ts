import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { exchangeApiConfig } from '../config/exchange-api.config.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { LedgerClientModule } from '../ledger/ledger-client.module.js';
import { ExchangeCustomersController } from './customers.controller.js';
import { ExchangeCustomersService } from './customers.service.js';
import { ExchangeBackendGuard } from './exchange-backend.guard.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { customerAuthConfig } from '../config/customer-auth.config.js';
import { CustomerAuthGuard } from '../auth/customer-auth.guard.js';
import { CustomerApiController } from './customer-api.controller.js';

@Module({
  imports: [
    ConfigModule.forFeature(exchangeApiConfig),
    ConfigModule.forFeature(customerAuthConfig),
    MessagingModule,
    WalletPrismaModule,
    LedgerClientModule,
  ],
  controllers: [ExchangeCustomersController, CustomerApiController],
  providers: [ExchangeCustomersService, ExchangeBackendGuard, CustomerAuthGuard],
  exports: [ExchangeCustomersService, ExchangeBackendGuard],
})
export class CustomersModule {}
