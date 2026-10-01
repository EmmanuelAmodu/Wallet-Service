import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Database, lockTransaction } from '../../../packages/database/src/client';
import { Message, MessageAuth, QUEUES } from '../../../packages/queue/src/messages';
import { enqueue } from '../../../packages/queue/src/outbox';
import { chainSchema, signedSchema, signSchema } from '../../../packages/shared/src/contracts';
import { networkFor } from '../../../packages/chain/src/config';
import { BroadcastRpc } from './rpc';

export const BROADCAST_CONFIG = 'BROADCAST_CONFIG';
export interface BroadcastConfig {
  allowBroadcast: boolean;
  ethereumChainId: string;
  solanaGenesisHash: string;
  pollIntervalMs: number;
  maxPolls: number;
}
type Action = Extract<Message, { type: 'broadcast.requested' | 'broadcast.confirm' }>;
const active = ['queued', 'broadcasting', 'submitted', 'attention'];
@Processor(QUEUES.broadcast, { concurrency: 8 })
export class BroadcastWorker extends WorkerHost {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @Inject(BroadcastRpc) private readonly rpc: BroadcastRpc,
    @Inject(BROADCAST_CONFIG) private readonly config: BroadcastConfig,
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
    if (message.type !== 'broadcast.requested' && message.type !== 'broadcast.confirm')
      throw new UnrecoverableError('Unsupported broadcast action');
    try {
      await this.handle(message);
    } catch (error) {
      const exhausted =
        error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await this.db.transaction.updateMany({
        where: {
          id: message.transactionId,
          broadcast_generation: message.generation,
          status: { in: active },
        },
        data: {
          ...(exhausted ? { status: 'attention' } : {}),
          last_error: exhausted
            ? 'Broadcast/confirmation action stopped; review failed queue job and retry or refresh this transaction'
            : 'RPC outcome uncertain; retry will reconcile the same transaction hash',
        },
      });
      if (error instanceof UnrecoverableError) throw error;
      throw new Error('Broadcast/confirmation RPC operation failed', { cause: error });
    }
  }
  private async handle(action: Action) {
    const tx = await this.db.transaction.findUnique({
      where: { id: action.transactionId },
      include: { wallet: true },
    });
    if (!tx || tx.broadcast_generation !== action.generation || !active.includes(tx.status)) return;
    const chain = chainSchema.parse(tx.wallet.chain),
      signed = signedSchema.parse(tx.signed);
    if (tx.wallet.network !== networkFor(chain, this.config))
      throw new UnrecoverableError('Configured network differs from wallet network');
    if (action.type === 'broadcast.requested') {
      if (!this.config.allowBroadcast) throw new UnrecoverableError('Broadcasting is disabled');
      await this.db.transaction.updateMany({
        where: { id: tx.id, broadcast_generation: action.generation, status: { in: active } },
        data: { status: 'broadcasting', broadcast_attempts: { increment: 1 } },
      });
    }
    // Lookup before every send handles acceptance followed by a lost RPC response.
    const observed = await this.rpc.status(chain, signed.txHash);
    if (observed === 'confirmed' || observed === 'failed') {
      await this.record(action, observed);
      return;
    }
    if (action.type === 'broadcast.confirm') {
      if (action.poll >= this.config.maxPolls)
        throw new UnrecoverableError(
          'Confirmation monitoring exhausted; operator reconciliation required',
        );
      await this.record(
        action,
        observed === 'submitted' ? 'submitted' : undefined,
        action.poll + 1,
      );
      return;
    }
    if (observed === 'submitted') {
      await this.record(action, 'submitted', 0);
      return;
    }
    if (chain === 'solana') {
      const prepared = signSchema.parse({
        wallet: {
          chain,
          address: tx.wallet.address,
          account: tx.wallet.account,
          seedId: tx.wallet.seed_id,
        },
        transaction: tx.prepared,
      }).transaction;
      if (prepared.chain !== 'solana') throw new UnrecoverableError('Invalid prepared chain');
      const height = await this.rpc.call(chain, 'getBlockHeight', [{ commitment: 'finalized' }]);
      if (typeof height !== 'number' || !Number.isSafeInteger(height))
        throw new Error('Invalid block height');
      if (height > prepared.lastValidBlockHeight)
        throw new UnrecoverableError(
          'Solana blockhash expired; reconcile without automatic re-signing',
        );
    }
    await this.rpc.preflight(chain, signed);
    await this.rpc.broadcast(chain, signed);
    await this.record(action, 'submitted', 0);
  }
  private async record(
    action: Action,
    status?: 'submitted' | 'confirmed' | 'failed',
    nextPoll?: number,
  ) {
    await this.db.$transaction(async (db) => {
      await lockTransaction(db, action.transactionId);
      const tx = await db.transaction.findUnique({ where: { id: action.transactionId } });
      if (!tx || tx.broadcast_generation !== action.generation || !active.includes(tx.status))
        return;
      await db.transaction.update({
        where: { id: tx.id },
        data: { ...(status ? { status } : {}), last_error: null },
      });
      if (nextPoll !== undefined)
        await enqueue(
          db,
          QUEUES.broadcast,
          {
            type: 'broadcast.confirm',
            transactionId: tx.id,
            generation: action.generation,
            poll: nextPoll,
            ...(action.type === 'broadcast.confirm' && action.monitorId
              ? { monitorId: action.monitorId }
              : {}),
          },
          `confirm-${tx.id}-${action.generation}-${action.type === 'broadcast.confirm' && action.monitorId ? action.monitorId + '-' : ''}${nextPoll}`,
          this.config.pollIntervalMs,
        );
    });
  }
}
