import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { LedgerAuthGuard } from './ledger-auth.guard.js';
import { LedgerService } from './ledger.service.js';

@Controller('internal')
@UseGuards(LedgerAuthGuard)
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Get('wallets/:walletId/balances')
  balances(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.service.balances(walletId);
  }
}
