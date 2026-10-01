import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error';
import { BeforeApplicationShutdown } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MessageAuth, QUEUES } from '../../../../packages/queue/src/messages';
import { BroadcastService } from './broadcast.service';

@Processor(QUEUES.broadcast, { concurrency: 8 })
export class BroadcastProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: BroadcastService,
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
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      return await this.service.execute(message, finalAttempt);
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
