import { executionConfig } from '../config/execution.config.js';
import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { TokenAssetsService } from './token-assets.service.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { exchangeApiConfig } from '../config/exchange-api.config.js';
import { CustodyModule } from '../custody/custody.module.js';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { CustodyCommandsService } from './custody-commands.service.js';
import { CustodyController } from './custody.controller.js';

@Module({
  imports: [ChainModule,ConfigModule.forFeature(executionConfig),WalletPrismaModule, CustodyModule, ConfigModule.forFeature(exchangeApiConfig)],
  controllers: [CustodyController],
  providers: [CustodyCommandsService,TokenAssetsService],
})
export class CustodyApiModule {}
