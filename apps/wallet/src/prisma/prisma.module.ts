import { Module } from '@nestjs/common';
import { WalletPrismaService } from './prisma.service.js';
@Module({ providers: [WalletPrismaService], exports: [WalletPrismaService] })
export class WalletPrismaModule {}
