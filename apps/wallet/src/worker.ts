import { Inject, HttpException } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Prisma } from '@prisma/client';
import { Database } from './database';
import { lock, lockTransaction } from '../../../packages/database/src/locks';
import { MessageAuth, Message, QUEUES } from '../../../packages/queue/src/messages';
import { enqueue } from '../../../packages/queue/src/outbox';
import { Rpc } from '../../../packages/chain/src/rpc';
import { networkFor } from '../../../packages/chain/src/config';
import { chainSchema, signSchema, transferSchema } from '../../../packages/shared/src/contracts';
import { WALLET_CONFIG, WalletConfig } from './service';

@Processor(QUEUES.wallet, { concurrency: 8 })
export class WalletWorker extends WorkerHost {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @Inject(Rpc) private readonly rpc: Rpc,
    @Inject(WALLET_CONFIG) private readonly config: WalletConfig,
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
    if (message.type === 'transaction.prepare') {
      try {
        await this.prepare(message.transactionId);
      } catch (error) {
        const permanent =
          error instanceof UnrecoverableError ||
          (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500);
        if (permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1))
          await this.db.transaction.updateMany({
            where: { id: message.transactionId, status: 'preparing' },
            data: {
              status: 'rejected',
              last_error:
                'Transaction preparation failed; inspect RPC configuration, funds, and request',
            },
          });
        if (permanent) throw new UnrecoverableError('Transaction preparation rejected');
        throw new Error('Transaction preparation failed', { cause: error });
      }
      return;
    }
    if (
      ![
        'wallet.derived',
        'wallet.rejected',
        'transaction.signed',
        'transaction.rejected',
        'broadcast.updated',
      ].includes(message.type)
    )
      throw new UnrecoverableError('Unsupported wallet action');
    await this.db.$transaction(async (db) => {
      await lock(db, `inbox-${job.id}`);
      if (await db.inbox.findUnique({ where: { id: job.id! } })) return;
      if (message.type === 'broadcast.updated') {
        await db.transaction.updateMany({
          where: {
            id: message.transactionId,
            broadcast_generation: message.generation,
            broadcast_revision: { lt: message.revision },
            status: { in: ['queued', 'broadcasting', 'submitted', 'attention'] },
          },
          data: {
            status: message.status,
            broadcast_revision: message.revision,
            broadcast_attempts: message.attempts,
            last_error: message.lastError,
          },
        });
      } else if (message.type === 'wallet.derived') {
        const wallet = await db.wallet.findUnique({ where: { id: message.walletId } });
        if (wallet?.status === 'deriving') {
          if (message.path !== wallet.path)
            throw new UnrecoverableError('Signer derivation mismatch');
          await db.wallet.update({
            where: { id: wallet.id },
            data: { status: 'ready', address: message.address, last_error: null },
          });
        }
      } else if (message.type === 'wallet.rejected') {
        await db.wallet.updateMany({
          where: { id: message.walletId, status: 'deriving' },
          data: { status: 'rejected', last_error: 'Signer rejected address derivation' },
        });
      } else if (message.type === 'transaction.signed') {
        await db.transaction.updateMany({
          where: { id: message.transactionId, status: 'signing' },
          data: {
            status: 'signed',
            signed: message.signed,
            tx_hash: message.signed.txHash,
            last_error: null,
          },
        });
      } else if (message.type === 'transaction.rejected') {
        await db.transaction.updateMany({
          where: { id: message.transactionId, status: 'signing' },
          data: { status: 'rejected', last_error: 'Signer rejected transaction' },
        });
      }
      await db.inbox.create({ data: { id: job.id! } });
    });
  }
  private async prepare(id: string) {
    const tx = await this.db.transaction.findUnique({ where: { id }, include: { wallet: true } });
    if (!tx || tx.status !== 'preparing') return;
    const wallet = tx.wallet,
      chain = chainSchema.parse(wallet.chain);
    if (!wallet.address || wallet.network !== networkFor(chain, this.config))
      throw new UnrecoverableError('Wallet network mismatch');
    const prepared = await this.rpc.prepare(wallet.address, transferSchema.parse(tx.intent));
    const request = signSchema.parse({
      wallet: { chain, address: wallet.address, account: wallet.account, seedId: wallet.seed_id },
      transaction: prepared,
    });
    await this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const updated = await db.transaction.updateMany({
        where: { id, status: 'preparing' },
        data: { status: 'signing', prepared: prepared as Prisma.InputJsonValue },
      });
      if (updated.count)
        await enqueue(
          db,
          QUEUES.signer,
          { type: 'transaction.sign', transactionId: id, request },
          `sign-${id}`,
        );
    });
  }
}
