import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  Post,
  Param,
  Query,
  ParseUUIDPipe,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { OperationsService, operationsCommandSchema } from './operations.service.js';
import { operationsConfig, OperationsSettings } from '../config/operations.config.js';
import { matches } from '../../../../packages/shared/src/security/tokens.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
@Injectable()
export class OperationsGuard implements CanActivate {
  constructor(@Inject(operationsConfig.KEY) private readonly config: OperationsSettings) {}
  canActivate(context: ExecutionContext) {
    if (!this.config.apiKey)
      throw new ServiceUnavailableException('Operations credential is not configured');
    const key = context.switchToHttp().getRequest<Request>().headers['x-operations-key'];
    if (typeof key !== 'string' || !matches(this.config.apiKey, key))
      throw new UnauthorizedException('Unauthorized');
    return true;
  }
}
// The global Wallet service guard also requires its backend Bearer credential.
@Controller('internal/operations')
@UseGuards(OperationsGuard)
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}
  @Post('commands') command(
    @Body(new ZodValidationPipe(operationsCommandSchema))
    request: z.infer<typeof operationsCommandSchema>,
  ) {
    return this.operations.command(request);
  }

  @Get() status() {
    return this.operations.status();
  }

  @Get('executions/:transactionId/attempts') attempts(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
    @Query(
      new ZodValidationPipe(
        z
          .object({
            cursor: z
              .string()
              .regex(/^[1-9][0-9]{0,18}$/)
              .refine((n) => /^[1-9][0-9]{0,18}$/.test(n) && BigInt(n) <= 9223372036854775807n)
              .optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict(),
      ),
    )
    query: { cursor?: string; limit: number },
  ) {
    return this.operations.attempts(transactionId, query.cursor, query.limit);
  }

  @Get('preview') preview() {
    return this.operations.preview();
  }

  @Get('batches/:batchId') batch(@Param('batchId', new ParseUUIDPipe()) batchId: string) {
    return this.operations.batch(batchId);
  }

  @Get('metrics') metrics() {
    return this.operations.metrics();
  }
}
