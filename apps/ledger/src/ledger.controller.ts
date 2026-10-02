import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../../packages/shared/src/http/zod-validation.pipe.js';
import { ledgerWalletRegistrationSchema } from '../../../packages/shared/src/activity-contracts.js';
import { LedgerAuthGuard } from './ledger-auth.guard.js';
import { LedgerService } from './ledger.service.js';

@Controller('internal')
@UseGuards(LedgerAuthGuard)
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Post('wallets')
  registerWallet(@Body(new ZodValidationPipe(ledgerWalletRegistrationSchema)) body: unknown) {
    return this.service.registerWallet(ledgerWalletRegistrationSchema.parse(body));
  }

  @Get('wallets/:walletId/balances')
  balances(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('tenantId') tenantId: string,
  ) {
    return this.service.balances(walletId, tenantId);
  }
}
