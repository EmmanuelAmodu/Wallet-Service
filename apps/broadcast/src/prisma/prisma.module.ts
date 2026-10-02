import { Module } from '@nestjs/common';
import { BroadcastPrismaService } from './prisma.service.js';
@Module({ providers: [BroadcastPrismaService], exports: [BroadcastPrismaService] })
export class BroadcastPrismaModule {}
