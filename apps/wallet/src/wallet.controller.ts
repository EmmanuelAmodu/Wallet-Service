import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { transferSchema, walletRequest } from '../../../packages/shared/src/contracts';
import { TenantRequest } from '../../../packages/shared/src/http';
import { WalletService } from './service';

@Controller('v1')
export class WalletController {
  constructor(@Inject(WalletService) private readonly service: WalletService) {}

  @HttpCode(202)
  @Post('wallets')
  create(@Req() req: TenantRequest, @Body() body: unknown) {
    const input = walletRequest.parse(body);
    return this.service.createWallet(req.tenant, input.chain, input.externalId);
  }

  @Get('wallets/:id')
  wallet(@Req() req: TenantRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getWallet(req.tenant, id);
  }

  @HttpCode(202)
  @Post('wallets/:id/transactions')
  transfer(
    @Req() req: TenantRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    return this.service.createTransaction(
      req.tenant,
      id,
      z.string().min(1).max(128).parse(key),
      transferSchema.parse(body),
    );
  }

  @Get('transactions/:id')
  transaction(@Req() req: TenantRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getTransaction(req.tenant, id);
  }

  @HttpCode(202)
  @Post('transactions/:id/broadcast')
  broadcast(@Req() req: TenantRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.requestBroadcast(req.tenant, id);
  }

  @HttpCode(202)
  @Post('transactions/:id/refresh')
  refresh(@Req() req: TenantRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.requestRefresh(req.tenant, id);
  }
}
