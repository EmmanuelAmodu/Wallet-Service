import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { broadcastConfig } from './config/broadcast.config.js';
import { networkConfig } from '../../../packages/chain/src/config.js';
import { OutboxModule } from '../../../packages/queue/src/outbox.module.js';
import { BroadcastPrismaModule } from './prisma/prisma.module.js';
import { BroadcastPrismaService } from './prisma/prisma.service.js';
import { BroadcastModule } from './broadcast/broadcast.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [queueConfig, broadcastConfig, networkConfig],
    }),
    OutboxModule.register(BroadcastPrismaModule, BroadcastPrismaService),
    BroadcastModule,
  ],
})
export class AppModule {}
