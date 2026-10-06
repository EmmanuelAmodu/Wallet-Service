import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { SweepPrismaModule } from '../prisma/prisma.module.js';
import { SweepProcessor } from './sweep.processor.js';
import { SweepService } from './sweep.service.js';
import { SweepScheduler } from './sweep.scheduler.js';

@Module({
  imports: [SweepPrismaModule, MessagingModule],
  providers: [SweepService, SweepProcessor, SweepScheduler],
  exports: [SweepService],
})
export class SweepModule {}
