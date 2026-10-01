import { Module } from '@nestjs/common';
import { WalletPrismaModule } from '../prisma/prisma.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
@Module({
  imports: [WalletPrismaModule],
  controllers: [WalletsController],
  providers: [WalletsService],
})
export class WalletsModule {}
