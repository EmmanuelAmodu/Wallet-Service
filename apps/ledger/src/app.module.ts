import { rolloutConfig } from '../../../packages/shared/src/rollout.config.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { MessagingModule } from '../../../packages/queue/src/messaging.module.js';
import { ledgerConfig } from './config/ledger.config.js';
import { LedgerModule } from './ledger.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [rolloutConfig, queueConfig, ledgerConfig],
    }),
    MessagingModule,
    LedgerModule,
  ],
})
export class AppModule {}
