import { Module } from '@nestjs/common';
import { ActivityPrismaService } from './prisma.service.js';

@Module({ providers: [ActivityPrismaService], exports: [ActivityPrismaService] })
export class ActivityPrismaModule {}
