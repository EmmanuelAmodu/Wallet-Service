import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { activityProviderConfig } from '../config/activity-provider.config.js';
import { EXCHANGE_WATCH_PROVIDER } from './provider.contracts.js';
import { ExchangeProviderConfig, RoutingExchangeWatchProvider } from './provider.service.js';

@Module({
  imports: [ConfigModule.forFeature(activityProviderConfig)],
  providers: [
    {
      provide: EXCHANGE_WATCH_PROVIDER,
      inject: [activityProviderConfig.KEY],
      useFactory: (config: ExchangeProviderConfig) => new RoutingExchangeWatchProvider(config),
    },
  ],
  exports: [EXCHANGE_WATCH_PROVIDER],
})
export class ExchangeProviderModule {}
