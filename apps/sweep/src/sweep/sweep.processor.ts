import { BeforeApplicationShutdown } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { SweepService } from './sweep.service.js';

@Processor(QUEUES.sweep, { concurrency: 4 })
export class SweepProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: SweepService,
    private readonly auth: MessageAuth,
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
    try {
      if (!('schemaVersion' in message)) throw new ActionRejectedError('Unsupported sweep action');
      await this.service.handle(message);
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
