import { IdempotencyKey } from './idempotency-key.decorator';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Tenant } from '../auth/tenant.decorator';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe';
import {
  CreateTransactionDto,
  createTransactionSchema,
  idempotencyKeySchema,
} from './dto/create-transaction.dto';
import { TransactionsService } from './transactions.service';

@Controller('v1')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}
  @HttpCode(202)
  @Post('wallets/:id/transactions')
  create(
    @Tenant() tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransactionDto,
  ) {
    return this.service.createTransaction(tenant, id, key, body);
  }
  @Get('transactions/:id')
  findOne(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getTransaction(tenant, id);
  }
  @HttpCode(202)
  @Post('transactions/:id/broadcast')
  broadcast(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestBroadcast(tenant, id);
  }
  @HttpCode(202)
  @Post('transactions/:id/refresh')
  refresh(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestRefresh(tenant, id);
  }
}
