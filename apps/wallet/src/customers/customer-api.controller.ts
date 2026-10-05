import {
  Body,
  Controller,
  Get,
  BadRequestException,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { networkFor } from '../../../../packages/chain/src/config.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import {
  CurrentUser,
  CustomerAuthenticatedRoute,
  CustomerAuthGuard,
} from '../auth/customer-auth.guard.js';
import { ExchangeCustomersService } from './customers.service.js';
import { walletConfig, WalletSettings } from '../config/wallet.config.js';

const emptyQuery = z.object({}).strict();
const assignment = z
  .object({ chain: z.enum(['ethereum', 'bitcoin', 'solana']), network: z.string().min(1).max(128) })
  .strict();
const history = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

@ApiTags('My wallet')
@ApiBearerAuth('customerBearer')
@CustomerAuthenticatedRoute()
@UseGuards(CustomerAuthGuard)
@Controller('v1/me')
export class CustomerApiController {
  constructor(
    private readonly customers: ExchangeCustomersService,
    @Inject(walletConfig.KEY) private readonly settings: WalletSettings,
  ) {}

  @Get()
  async profile(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      return await this.customers.get(userId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      response.status(202);
      return { customerId: userId, state: 'awaiting_customer_registration' };
    }
  }

  @Post('deposit-addresses')
  assign(
    @CurrentUser() userId: string,
    @Body(new ZodValidationPipe(assignment)) body: z.infer<typeof assignment>,
  ) {
    if (body.network !== networkFor(body.chain, this.settings))
      throw new BadRequestException('Network is not enabled for customer deposits');
    return this.customers.assign(userId, body.chain, body.network);
  }

  @Get('deposit-addresses/:assignmentId')
  address(
    @CurrentUser() userId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
  ) {
    return this.customers.assignment(userId, assignmentId);
  }

  @Get('balances')
  async balances(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const balances = await this.customers.balances(userId);
    if (balances.state === 'awaiting_ledger_registration') response.status(202);
    return balances;
  }

  @Get('deposits')
  deposits(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(history)) query: z.infer<typeof history>,
  ) {
    return this.customers.deposits(userId, query.cursor, query.limit);
  }
}
