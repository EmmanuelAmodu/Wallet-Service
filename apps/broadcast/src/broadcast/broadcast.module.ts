import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module';
import { BroadcastPrismaModule } from '../prisma/prisma.module';
import { BroadcastProcessor } from './broadcast.processor';
import { BroadcastService } from './broadcast.service';
import { BroadcastRpcService } from './broadcast-rpc.service';
@Module({
  imports: [MessagingModule, BroadcastPrismaModule],
  providers: [BroadcastProcessor, BroadcastService, BroadcastRpcService],
})
export class BroadcastModule {}
