import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant } from '../auth/tenant.decorator.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { supportedChains } from '../../../../packages/shared/src/contracts.js';
import type { LedgerWalletRegistration } from '../../../../packages/shared/src/activity-contracts.js';
import { LedgerClient } from '../ledger/ledger-client.service.js';
import { CreateWalletDto, createWalletSchema } from './dto/create-wallet.dto.js';
import { WalletsService } from './wallets.service.js';

@ApiTags('Wallets')
@ApiBearerAuth('tenantBearer')
@Controller('v1/wallets')
export class WalletsController {
  constructor(
    private readonly service: WalletsService,
    private readonly ledger: LedgerClient,
  ) {}

  @HttpCode(202)
  @ApiOperation({ summary: 'Create or return a wallet for an external customer' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['chain', 'externalId'],
      properties: {
        chain: { type: 'string', enum: [...supportedChains] },
        externalId: { type: 'string', minLength: 1, maxLength: 128 },
      },
      additionalProperties: false,
    },
  })
  @ApiAcceptedResponse({ description: 'Wallet accepted; address derivation is asynchronous.' })
  @ApiBadRequestResponse({ description: 'Unsupported chain or invalid request.' })
  @Post()
  create(
    @Tenant() tenant: string,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto,
  ) {
    return this.service.createWallet(tenant, body.chain, body.externalId);
  }

  @ApiOperation({ summary: 'Get wallet derivation and readiness status' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Wallet status, address, network, and derivation metadata.' })
  @ApiNotFoundResponse({ description: 'Wallet not found for this tenant.' })
  @Get(':id')
  findOne(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getWallet(tenant, id);
  }

  @ApiOperation({ summary: 'Get confirmed and provisional asset balances for a wallet' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Ledger balances in the asset’s smallest unit.' })
  @ApiNotFoundResponse({ description: 'Wallet not found for this tenant.' })
  @ApiBadGatewayResponse({ description: 'Ledger service is unavailable.' })
  @Get(':id/balances')
  async balances(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    const wallet = await this.service.getWallet(tenant, id);
    if (!wallet.address) return { walletId: wallet.id, chain: wallet.chain, balances: [] };
    return this.ledger.balances({
      walletId: wallet.id,
      tenantId: tenant,
      chain: wallet.chain as LedgerWalletRegistration['chain'],
      network: wallet.network,
      address: wallet.address,
    });
  }
}
