import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { retryFailedConsumerJobs } from '../../../../packages/queue/src/consumer-repair.js';
import { ReconciliationService } from '../operations/reconciliation.service.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { queueConfig, QueueConfig } from '../../../../packages/queue/src/queue.config.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { DepositsService } from '../deposits/deposits.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { SettlementsService } from '../settlements/settlements.service.js';
import { ExchangeRegistryService } from './registry.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';

@Injectable()
export class LedgerExchangeService {
  constructor(
    private readonly registry: ExchangeRegistryService,
    private readonly deposits: DepositsService,
    private readonly reservations: ReservationsService,
    private readonly settlements: SettlementsService,
    @Inject(queueConfig.KEY) private readonly config: Pick<QueueConfig, 'resetEpoch'>,
    @Optional() private readonly incidents?: IncidentsService,
    @Optional() private readonly operations?: ReconciliationService,
    @Optional() @InjectQueue(QUEUES.ledger) private readonly queue?: Queue,
    @Optional() private readonly auth?: MessageAuth,
  ) {}

  async handle(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (event.resetEpoch !== this.config.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    if (
      event.type === 'operations.custody.observed.v1' ||
      event.type === 'operations.repair.requested.v1' ||
      event.type === 'operations.domain.resume.requested.v1'
    ) {
      if (!this.operations) throw new Error('Operational reconciliation unavailable');
      if (event.type === 'operations.repair.requested.v1' && this.queue && this.auth)
        await retryFailedConsumerJobs(this.queue, this.auth, event.domainId);
      return this.operations.handle(event);
    }
    if (
      event.type === 'custody.loss.detected.v1' ||
      event.type === 'custody.loss.reverted.v1' ||
      event.type === 'custody.incident.opened.v1'
    ) {
      if (!this.incidents) throw new Error('Custody incident accounting unavailable');
      return this.incidents.handle(event);
    }
    if (
      event.type === 'customer-wallet.registry.requested.v1' ||
      event.type === 'custody-wallet.registry.requested.v1' ||
      event.type === 'customer.registry.requested.v1'
    )
      return this.registry.handle(event);
    if (
      event.type === 'deposit.observed.v1' ||
      event.type === 'deposit.finalized.v1' ||
      event.type === 'deposit.reverted.v1'
    )
      return this.deposits.handle(event);
    if (
      event.type === 'withdrawal.reserve.requested.v1' ||
      event.type === 'reservation.release.requested.v1'
    )
      return this.reservations.handle(event);
    if (
      event.type === 'sweep.execute.requested.v1' ||
      event.type === 'funding.execute.requested.v1' ||
      event.type === 'withdrawal.execute.requested.v1' ||
      event.type === 'execution.attempt.updated.v1' ||
      event.type === 'settlement.requested.v1' ||
      event.type === 'settlement.reverted.v1'
    )
      return this.settlements.handle(event);
    // Reconciliation results are evidence for operators, never authorization to release a hold.
    if (event.type === 'operation.reconcile.responded.v1')
      return this.reservations.recordReconciliation(event);
    throw new ActionRejectedError('Unsupported exchange ledger action');
  }
}
