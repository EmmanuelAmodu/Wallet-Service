import { BeforeApplicationShutdown } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { ActionRejectedError } from '../../../packages/shared/src/action-rejected.error.js';
import { Message, MessageAuth, QUEUES } from '../../../packages/queue/src/messages.js';
import { ActivityWorkflowService } from './activity-workflow.service.js';

@Processor(QUEUES.activity, { concurrency: 4 })
export class ActivityProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: ActivityWorkflowService,
    private readonly auth: MessageAuth,
  ) {
    super();
  }

  async beforeApplicationShutdown() {
    await this.worker.close();
  }

  async process(job: Job) {
    let message: Message;
    try {
      message = this.auth.open(job.data, job.id!, job.name);
    } catch {
      throw new UnrecoverableError('Invalid queue message');
    }
    try {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (message.type === 'activity.received')
        await this.service.receive(message.activity, message.pubsubMessageId, finalAttempt);
      else if (message.type === 'activity.check-finality')
        await this.service.resumeFinality(
          message.activity,
          message.poll,
          message.blockHash,
          finalAttempt,
          message.previouslyIncluded,
        );
      else if (message.type === 'activity.invalid')
        throw new ActionRejectedError(`Invalid provider activity: ${message.reason}`);
      else throw new ActionRejectedError('Unsupported activity action');
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
