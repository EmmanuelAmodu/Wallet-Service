import { IdempotencyKey } from './idempotency-key.decorator.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  type SchemaObject,
} from '@nestjs/swagger';
import { Tenant } from '../auth/tenant.decorator.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import {
  bitcoinChains,
  evmChains,
  solanaChains,
} from '../../../../packages/shared/src/contracts.js';
import {
  CreateTransactionDto,
  createTransactionSchema,
  idempotencyKeySchema,
} from './dto/create-transaction.dto.js';
import { TransactionsService } from './transactions.service.js';

const amount: SchemaObject = { type: 'string', pattern: '^[1-9][0-9]*$' };
const transferOutputs: SchemaObject = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: {
    type: 'object',
    required: ['address', 'amount'],
    properties: { address: { type: 'string' }, amount },
    additionalProperties: false,
  },
};
const transactionBody: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['chain', 'to', 'amount', 'maxFeePerGas', 'maxPriorityFeePerGas'],
      properties: {
        chain: { type: 'string', enum: [...evmChains] },
        to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        amount,
        maxFeePerGas: amount,
        maxPriorityFeePerGas: amount,
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['chain', 'outputs', 'utxos', 'satsPerVbyte'],
      properties: {
        chain: { type: 'string', enum: [...bitcoinChains] },
        outputs: transferOutputs,
        utxos: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['txid', 'vout'],
            properties: {
              txid: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              vout: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        satsPerVbyte: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['chain', 'outputs'],
      properties: {
        chain: { type: 'string', enum: [...solanaChains] },
        outputs: { ...transferOutputs, maxItems: 20 },
      },
      additionalProperties: false,
    },
  ],
};

@ApiTags('Transactions')
@ApiBearerAuth('tenantBearer')
@Controller('v1')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @HttpCode(202)
  @ApiOperation({ summary: 'Prepare and sign a native asset transfer' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Wallet ID' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiBody({ schema: transactionBody })
  @ApiAcceptedResponse({ description: 'Accepted for asynchronous preparation and signing.' })
  @ApiBadRequestResponse({ description: 'Unsupported chain or invalid transfer.' })
  @ApiConflictResponse({ description: 'Wallet is not ready or another transfer is pending.' })
  @Post('wallets/:id/transactions')
  create(
    @Tenant() tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @Body(new ZodValidationPipe(createTransactionSchema)) body: CreateTransactionDto,
  ) {
    return this.service.createTransaction(tenant, id, key, body);
  }

  @ApiOperation({ summary: 'Get transaction preparation, signing, and broadcast status' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Transaction state and signed transaction data, when available.' })
  @ApiNotFoundResponse({ description: 'Transaction not found for this tenant.' })
  @Get('transactions/:id')
  findOne(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getTransaction(tenant, id);
  }

  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a signed transaction for broadcast' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ description: 'Broadcast request accepted.' })
  @ApiConflictResponse({ description: 'Transaction is not signed or is in an incompatible state.' })
  @Post('transactions/:id/broadcast')
  broadcast(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestBroadcast(tenant, id);
  }

  @HttpCode(202)
  @ApiOperation({
    summary: 'Restart confirmation monitoring for a transaction requiring attention',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ description: 'A new bounded confirmation-monitoring run was accepted.' })
  @ApiConflictResponse({ description: 'Only signed transactions in attention can be refreshed.' })
  @Post('transactions/:id/refresh')
  refresh(@Tenant() tenant: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestRefresh(tenant, id);
  }
}
