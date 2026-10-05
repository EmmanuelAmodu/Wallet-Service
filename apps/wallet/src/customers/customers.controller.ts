import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { chainSchema } from '../../../../packages/shared/src/contracts.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { ExchangeBackendGuard, ExchangeBackendRoute } from './exchange-backend.guard.js';
import { ExchangeCustomersService } from './customers.service.js';
import type { Response } from 'express';

const assignmentSchema = z
  .object({ chain: chainSchema, network: z.string().min(1).max(128) })
  .strict();
const historySchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const emptyQuerySchema = z.object({}).strict();

@ExchangeBackendRoute()
@UseGuards(ExchangeBackendGuard)
@Controller('internal/customers')
export class ExchangeCustomersController {
  constructor(private readonly customers: ExchangeCustomersService) {}

  @Get(':customerId')
  get(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>,
  ) {
    return this.customers.get(customerId);
  }

  @Post(':customerId/deposit-addresses')
  assign(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(assignmentSchema)) body: z.infer<typeof assignmentSchema>,
  ) {
    return this.customers.assign(customerId, body.chain, body.network);
  }

  @Get(':customerId/deposit-addresses/:assignmentId')
  assignment(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>,
  ) {
    return this.customers.assignment(customerId, assignmentId);
  }

  @Get(':customerId/balances')
  async balances(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query(new ZodValidationPipe(emptyQuerySchema)) _query: Record<string, never>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const balances = await this.customers.balances(customerId);
    if (balances.state === 'awaiting_ledger_registration') response.status(202);
    return balances;
  }

  @Get(':customerId/deposits')
  deposits(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query(new ZodValidationPipe(historySchema)) query: z.infer<typeof historySchema>,
  ) {
    return this.customers.deposits(customerId, query.cursor, query.limit);
  }
}
