import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ActivityPrismaModule } from '../prisma/prisma.module.js';
import { ActivityRegistryService } from './registry.service.js';

@Module({
  imports: [ActivityPrismaModule, MessagingModule],
  providers: [ActivityRegistryService],
  exports: [ActivityRegistryService],
})
export class ActivityRegistryModule {}
