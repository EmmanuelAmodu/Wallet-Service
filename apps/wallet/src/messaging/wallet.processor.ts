import { OperationsService } from '../operations/operations.service.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { BeforeApplicationShutdown, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MessageAuth, QUEUES, isExchangeEvent } from '../../../../packages/queue/src/messages.js';
import { WalletWorkflowService } from './wallet-workflow.service.js';
import { ExchangeMessagingService } from '../exchange-messaging/exchange-messaging.service.js';
import { CustodyExecutionService } from '../execution/execution.service.js';

import { WithdrawalsService } from '../withdrawals/withdrawals.service.js';
import { BitcoinBatchExecutionService } from '../execution/bitcoin-batch-execution.service.js';

@Processor(QUEUES.wallet, { concurrency: 8 })
export class WalletProcessor extends WorkerHost implements BeforeApplicationShutdown {
  constructor(
    private readonly service: WalletWorkflowService,
    private readonly auth: MessageAuth,
    @Optional() private readonly exchange?: ExchangeMessagingService,
    @Optional() private readonly execution?: CustodyExecutionService,
    @Optional() private readonly withdrawals?: WithdrawalsService,
    @Optional() private readonly operations?: OperationsService,
    @Optional() private readonly batches?: BitcoinBatchExecutionService,
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
      if (this.operations && (await this.operations.handle(message))) return;
      if (this.batches && (await this.batches.handle(message))) return;
      if (this.execution && (await this.execution.handle(message))) return;
      await this.withdrawals?.handle(message);
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
