import { rolloutConfig } from '../../../packages/shared/src/rollout.config.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagingModule } from '../../../packages/queue/src/messaging.module.js';
import { OutboxModule } from '../../../packages/queue/src/outbox.module.js';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { sweepConfig } from './config/sweep.config.js';
import { SweepPrismaModule } from './prisma/prisma.module.js';
import { SweepPrismaService } from './prisma/prisma.service.js';
import { SweepModule } from './sweep/sweep.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [rolloutConfig, queueConfig, sweepConfig],
    }),
    MessagingModule,
    SweepModule,
    OutboxModule.register(SweepPrismaModule, SweepPrismaService),
  ],
})
export class AppModule {}
