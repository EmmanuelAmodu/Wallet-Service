import { Module } from '@nestjs/common';
import { networkConfig } from '../../../packages/chain/src/config';
import { Database } from '../../../packages/database/src/client';
import { MessagingModule } from '../../../packages/queue/src/module';
import { OutboxRelay } from '../../../packages/queue/src/outbox';
import { integerSetting } from '../../../packages/shared/src/config';
import { BroadcastRpc } from './rpc';
import { BROADCAST_CONFIG, BroadcastWorker } from './worker';

@Module({
  imports: [MessagingModule.register()],
  providers: [
    Database,
    OutboxRelay,
    BroadcastWorker,
    { provide: BroadcastRpc, useFactory: () => new BroadcastRpc(networkConfig()) },
    {
      provide: BROADCAST_CONFIG,
      useFactory: () => ({
        ...networkConfig(),
        allowBroadcast: process.env.ALLOW_BROADCAST === 'true',
        pollIntervalMs: integerSetting('CONFIRMATION_POLL_MS', 30000, 10, 86400000),
        maxPolls: integerSetting('CONFIRMATION_MAX_POLLS', 120, 1, 10000),
      }),
    },
  ],
})
export class BroadcastModule {}
