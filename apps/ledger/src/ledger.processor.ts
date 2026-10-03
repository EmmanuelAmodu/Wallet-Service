import { BeforeApplicationShutdown } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { ActionRejectedError } from '../../../packages/shared/src/action-rejected.error.js';
import { Message, MessageAuth, QUEUES } from '../../../packages/queue/src/messages.js';
import { LedgerService } from './ledger.service.js';

@Processor(QUEUES.ledger, { concurrency: 8 })
export class LedgerProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: LedgerService,
    private readonly auth: MessageAuth,
  ) {
    super();
  }

  async beforeApplicationShutdown() {
    await this.worker.close();
  }

  async process(job: Job): Promise<void> {
    let message: Message;
    try {
      message = this.auth.open(job.data, job.id!, job.name);
    } catch {
      throw new UnrecoverableError('Invalid queue message');
    }
    try {
      if (message.type === 'ledger.wallet.registered') {
        await this.service.registerWallet(message);
        return;
      }
      if (message.type === 'ledger.activity.update') {
        await this.service.applyActivity(message.activity);
        return;
      }
      throw new ActionRejectedError('Unsupported ledger action');
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
