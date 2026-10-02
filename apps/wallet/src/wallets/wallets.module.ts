import { Module } from '@nestjs/common';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';
@Module({
  imports: [WalletPrismaModule],
  controllers: [WalletsController],
  providers: [WalletsService],
})
export class WalletsModule {}
