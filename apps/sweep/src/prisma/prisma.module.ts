import { Module } from '@nestjs/common';
import { SweepPrismaService } from './prisma.service.js';

@Module({ providers: [SweepPrismaService], exports: [SweepPrismaService] })
export class SweepPrismaModule {}
