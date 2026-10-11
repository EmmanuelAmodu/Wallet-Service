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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import {
  CurrentUser,
  CustomerAuthenticatedRoute,
  CustomerAuthGuard,
} from '../auth/customer-auth.guard.js';
import {
  WithdrawalsService,
  withdrawalRequestSchema,
  WithdrawalRequest,
} from './withdrawals.service.js';
const empty = z.object({}).strict();
const history = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
@ApiTags('My withdrawals')
@ApiBearerAuth('customerBearer')
@CustomerAuthenticatedRoute()
@UseGuards(CustomerAuthGuard)
@Controller('v1/me/withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}
  @Post()
  request(
    @CurrentUser() customerId: string,
    @Body(new ZodValidationPipe(withdrawalRequestSchema)) body: WithdrawalRequest,
  ) {
    return this.withdrawals.request(customerId, body);
  }

  @Get()
  list(
    @CurrentUser() customerId: string,
    @Query(new ZodValidationPipe(history)) query: z.infer<typeof history>,
  ) {
    return this.withdrawals.list(customerId, query.cursor, query.limit);
  }

  @Get(':id')
  get(
    @CurrentUser() customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(empty)) _query: Record<string, never>,
  ) {
    return this.withdrawals.get(customerId, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(empty)) _body: Record<string, never>,
  ) {
    return this.withdrawals.cancel(customerId, id);
  }
}
