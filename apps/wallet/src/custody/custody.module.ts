import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { exchangeApiConfig } from '../config/exchange-api.config.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { CustodyService } from './custody.service.js';

@Module({
  imports: [WalletPrismaModule, ConfigModule.forFeature(exchangeApiConfig)],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
