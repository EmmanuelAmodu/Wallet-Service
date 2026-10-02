import { Inject, Injectable, HttpException } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Prisma } from '@prisma/client';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock, lockTransaction } from '../../../../packages/database/src/locks.js';
import { Message, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import {
  chainSchema,
  signSchema,
  transferSchema,
} from '../../../../packages/shared/src/contracts.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';

@Injectable()
export class WalletWorkflowService {
  constructor(
    @Inject(WalletPrismaService) private readonly db: WalletPrismaService,
    @Inject(ChainRpcService) private readonly rpc: ChainRpcService,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
  ) {}

  async handle(message: Message, messageId: string, finalAttempt: boolean) {
    if (message.type === 'transaction.prepare') {
      try {
        await this.prepare(message.transactionId);
      } catch (error) {
        const permanent =
          error instanceof ActionRejectedError ||
          (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500);
        if (permanent || finalAttempt)
          await this.db.transaction.updateMany({
            where: { id: message.transactionId, status: 'preparing' },
            data: {
              status: 'rejected',
              last_error:
                'Transaction preparation failed; inspect RPC configuration, funds, and request',
            },
          });
        if (permanent) throw new ActionRejectedError('Transaction preparation rejected');
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
      throw new ActionRejectedError('Unsupported wallet action');
    await this.db.$transaction(async (db) => {
      await lock(db, `inbox-${messageId}`);
      if (await db.inbox.findUnique({ where: { id: messageId } })) return;
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
        if (wallet && ['deriving', 'ready'].includes(wallet.status)) {
          if (message.path !== wallet.path)
            throw new ActionRejectedError('Signer derivation mismatch');
          if (wallet.status === 'deriving')
            await db.wallet.update({
              where: { id: wallet.id },
              data: { status: 'ready', address: message.address, last_error: null },
            });
          await enqueue(
            db,
            QUEUES.ledger,
            {
              type: 'ledger.wallet.registered',
              walletId: wallet.id,
              tenantId: wallet.tenant_id,
              chain: chainSchema.parse(wallet.chain),
              network: wallet.network,
              address: message.address,
            },
            `ledger-wallet-${wallet.id}`,
          );
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
      await db.inbox.create({ data: { id: messageId } });
    });
  }

  private async prepare(id: string) {
    const tx = await this.db.transaction.findUnique({ where: { id }, include: { wallet: true } });
    if (!tx || tx.status !== 'preparing') return;
    const wallet = tx.wallet,
      chain = chainSchema.parse(wallet.chain);
    if (!wallet.address || wallet.network !== networkFor(chain, this.config))
      throw new ActionRejectedError('Wallet network mismatch');
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
