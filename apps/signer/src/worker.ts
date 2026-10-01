import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { Message, MessageAuth, QUEUES } from '../../../packages/queue/src/messages';
import { SigningCore } from './core';

@Processor(QUEUES.signer, { concurrency: 1 })
export class SignerWorker extends WorkerHost implements OnApplicationShutdown {
  constructor(
    @Inject(SigningCore) private readonly core: SigningCore,
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
    if (action.type === 'wallet.derive') {
      try {
        const derived = this.core.derive(action.request);
        result = {
          type: 'wallet.derived',
          walletId: action.walletId,
          address: derived.address,
          path: derived.path,
        };
      } catch {
        result = { type: 'wallet.rejected', walletId: action.walletId };
      }
    } else if (action.type === 'transaction.sign') {
      try {
        result = {
          type: 'transaction.signed',
          transactionId: action.transactionId,
          signed: this.core.sign(action.request),
        };
      } catch {
        result = { type: 'transaction.rejected', transactionId: action.transactionId };
      }
    } else throw new UnrecoverableError('Unsupported signer action');
    // Publish before acknowledging the command. Retrying derivation/signing has no chain side effect.
    const id = `result-${job.id}`;
    await this.results.add(result.type, this.auth.seal(result, id), { jobId: id });
  }
  onApplicationShutdown() {
    this.core.close();
  }
}
