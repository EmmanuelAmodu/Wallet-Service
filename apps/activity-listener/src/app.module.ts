import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainModule } from '../../../packages/chain/src/chain.module.js';
import { networkConfig } from '../../../packages/chain/src/config.js';
import { MessagingModule } from '../../../packages/queue/src/messaging.module.js';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { activityListenerConfig } from './config/activity-listener.config.js';
import { ActivityPubSubService } from './activity-pubsub.service.js';
import { ActivityProcessor } from './activity.processor.js';
import { ActivityWorkflowService } from './activity-workflow.service.js';
import { activityRegistryConfig } from './config/activity-registry.config.js';
import { ActivityRegistryModule } from './registry/registry.module.js';
import { ActivityPrismaModule } from './prisma/prisma.module.js';
import { ActivityPrismaService } from './prisma/prisma.service.js';
import { OutboxModule } from '../../../packages/queue/src/outbox.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [queueConfig, networkConfig, activityListenerConfig, activityRegistryConfig],
    }),
    MessagingModule,
    ChainModule,
    ActivityRegistryModule,
    OutboxModule.register(ActivityPrismaModule, ActivityPrismaService),
  ],
  providers: [ActivityPubSubService, ActivityProcessor, ActivityWorkflowService],
})
export class AppModule {}
