import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Inject, BeforeApplicationShutdown } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { Message, MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { SigningService } from './signing.service.js';

@Processor(QUEUES.signer, { concurrency: 1 })
export class SignerProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: SigningService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @InjectQueue(QUEUES.wallet) private readonly results: Queue,
  ) {
    super();
  }

  async beforeApplicationShutdown() {
    await this.worker.close();
  }

  async process(job: Job) {
    let action: Message;
    try {
      action = this.auth.open(job.data, job.id!, job.name);
    } catch {
      throw new UnrecoverableError('Invalid queue message');
    }
    let result: Message;
    try {
      result = this.service.execute(action);
    } catch (error) {
      if (error instanceof ActionRejectedError) throw new UnrecoverableError(error.message);
      throw error;
    }
    // Publish before acknowledging the command. Retrying derivation/signing has no chain side effect.
    const id = `result-${job.id}`;
    await this.results.add(result.type, this.auth.seal(result, id), { jobId: id });
  }
}
