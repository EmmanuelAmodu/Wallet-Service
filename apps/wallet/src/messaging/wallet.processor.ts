import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { BeforeApplicationShutdown, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MessageAuth, QUEUES, isExchangeEvent } from '../../../../packages/queue/src/messages.js';
import { WalletWorkflowService } from './wallet-workflow.service.js';
import { ExchangeMessagingService } from '../exchange-messaging/exchange-messaging.service.js';

@Processor(QUEUES.wallet, { concurrency: 8 })
export class WalletProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: WalletWorkflowService,
    private readonly auth: MessageAuth,
    @Optional() private readonly exchange?: ExchangeMessagingService,
  ) {
    super();
  }

  async beforeApplicationShutdown() {
    await this.worker.close();
  }

  async process(job: Job) {
    let message;
    try {
      message = this.auth.open(job.data, job.id!, job.name);
    } catch {
      throw new UnrecoverableError('Invalid queue message');
    }
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      if (isExchangeEvent(message)) {
        if (!this.exchange) throw new ActionRejectedError('Exchange projection unavailable');
        await this.exchange.handle(message);
        return;
      }
      return await this.service.handle(message, job.id!, finalAttempt);
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
