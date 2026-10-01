import { Module } from '@nestjs/common';
import { WalletPrismaService } from './prisma.service';
@Module({ providers: [WalletPrismaService], exports: [WalletPrismaService] })
export class WalletPrismaModule {}
