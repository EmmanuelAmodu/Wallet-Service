import { Module } from '@nestjs/common';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';
import { LedgerClientModule } from '../ledger/ledger-client.module.js';
@Module({
  imports: [WalletPrismaModule, LedgerClientModule],
  controllers: [WalletsController],
  providers: [WalletsService],
})
export class WalletsModule {}
