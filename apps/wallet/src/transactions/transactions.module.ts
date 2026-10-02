import { Module } from '@nestjs/common';
import { WalletPrismaModule } from '../prisma/prisma.module.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';
@Module({
  imports: [WalletPrismaModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
