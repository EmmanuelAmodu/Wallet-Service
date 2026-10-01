import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Tenant } from '../auth/tenant.decorator';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe';
import { CreateWalletDto, createWalletSchema } from './dto/create-wallet.dto';
import { WalletsService } from './wallets.service';

@Controller('v1/wallets')
export class WalletsController {
  constructor(private readonly service: WalletsService) {}
  @HttpCode(202)
  @Post()
  create(
    @Tenant() tenant: string,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto,
  ) {
    return this.service.createWallet(tenant, body.chain, body.externalId);
  }
  @Get(':id')
  findOne(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getWallet(tenant, id);
  }
}
