import { Module } from '@nestjs/common';
import { LedgerPrismaService } from './prisma.service.js';

@Module({ providers: [LedgerPrismaService], exports: [LedgerPrismaService] })
export class LedgerPrismaModule {}
