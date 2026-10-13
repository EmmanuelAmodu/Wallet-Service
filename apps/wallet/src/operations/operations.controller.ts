import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  Post,
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

  @Get('metrics') metrics() {
    return this.operations.metrics();
  }
}
