import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { BroadcastPrismaModule } from '../prisma/prisma.module.js';
import { BroadcastProcessor } from './broadcast.processor.js';
import { BroadcastService } from './broadcast.service.js';
import { BroadcastRpcService } from './broadcast-rpc.service.js';
@Module({
  imports: [MessagingModule, BroadcastPrismaModule],
  providers: [BroadcastProcessor, BroadcastService, BroadcastRpcService],
})
export class BroadcastModule {}
