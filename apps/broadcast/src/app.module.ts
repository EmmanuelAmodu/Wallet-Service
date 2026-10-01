import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config';
import { broadcastConfig } from './config/broadcast.config';
import { networkConfig } from '../../../packages/chain/src/config';
import { OutboxModule } from '../../../packages/queue/src/outbox.module';
import { BroadcastPrismaModule } from './prisma/prisma.module';
import { BroadcastPrismaService } from './prisma/prisma.service';
import { BroadcastModule } from './broadcast/broadcast.module';

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
