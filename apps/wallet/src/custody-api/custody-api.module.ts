import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { exchangeApiConfig } from '../config/exchange-api.config.js';
import { CustodyModule } from '../custody/custody.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { CustodyCommandsService } from './custody-commands.service.js';
import { CustodyController } from './custody.controller.js';

@Module({
  imports: [WalletPrismaModule, CustodyModule, ConfigModule.forFeature(exchangeApiConfig)],
  controllers: [CustodyController],
  providers: [CustodyCommandsService],
})
export class CustodyApiModule {}
