import {
  Body,
  Controller,
  ConflictException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { LedgerAuthGuard } from '../ledger-auth.guard.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { ExchangeRegistryService } from './registry.service.js';
import { LedgerExchangeService } from './exchange.service.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';

const domainSchema = z.string().min(1).max(128);
const reconciliationSchema = z
  .object({ domainId: domainSchema, limit: z.number().int().min(1).max(100).default(100) })
  .strict();

@Controller('internal/exchange')
@UseGuards(LedgerAuthGuard)
export class LedgerExchangeController {
  constructor(
    private readonly exchange: LedgerExchangeService,
    private readonly registry: ExchangeRegistryService,
    private readonly reservations: ReservationsService,
  ) {}

  @Post('events')
  async event(@Body(new ZodValidationPipe(exchangeEventSchema)) event: ExchangeEvent) {
    try {
      await this.exchange.handle(event);
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new ConflictException(error.message);
      throw error;
    }
    return { eventId: event.eventId, accepted: true };
  }

  @Get('customers/:customerId/balances')
  balances(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('domainId', new ZodValidationPipe(domainSchema)) domainId: string,
  ) {
    return this.registry.balances(domainId, customerId);
  }

  @Get('reservations/:reservationId')
  reservation(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Query('domainId', new ZodValidationPipe(domainSchema)) domainId: string,
  ) {
    return this.reservations.get(domainId, reservationId);
  }

  @Get('reservations')
  reservationsList(
    @Query('domainId', new ZodValidationPipe(domainSchema)) domainId: string,
    @Query('cursor', new ZodValidationPipe(z.uuid().optional())) cursor?: string,
  ) {
    return this.reservations.list(domainId, cursor);
  }

  @Post('reservations/reconcile')
  async reconcile(
    @Body(new ZodValidationPipe(reconciliationSchema)) body: z.infer<typeof reconciliationSchema>,
  ) {
    return { requested: await this.reservations.reconcile(body.domainId, body.limit) };
  }
}
