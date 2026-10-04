import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { ExchangeVerifier } from '../../../../packages/chain/src/exchange-verifier.js';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ActivityPrismaModule } from '../prisma/prisma.module.js';
import { ActivityRegistryModule } from '../registry/registry.module.js';
import {
  exchangeObservationConfig,
  ExchangeObservationSettings,
} from '../config/exchange-observation.config.js';
import { ActivityExchangeService } from './exchange.service.js';
@Module({
  imports: [
    ActivityPrismaModule,
    ActivityRegistryModule,
    MessagingModule,
    ConfigModule.forFeature(exchangeObservationConfig),
  ],
  providers: [
    ActivityExchangeService,
    {
      provide: ExchangeVerifier,
      inject: [exchangeObservationConfig.KEY],
      useFactory: (config: ExchangeObservationSettings) =>
        new ExchangeVerifier(
          new ChainRpcService(config),
          config.traceMode === 'callTracer' ? { evmTraceMode: 'callTracer' } : {},
        ),
    },
  ],
  exports: [ActivityExchangeService],
})
export class ActivityExchangeModule {}
