import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaClient, WalletTransactionStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock, lockTransaction } from '../../../../packages/database/src/locks.js';
import { Transfer } from '../../../../packages/shared/src/contracts.js';
import {
  broadcastSnapshotSchema,
  canonical,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';

import { walletConfig, WalletConfig } from '../config/wallet.config.js';

export const pendingStatuses: WalletTransactionStatus[] = [
  'preparing',
  'signing',
  'signed',
  'queued',
  'broadcasting',
  'submitted',
  'attention',
];
@Injectable()
export class TransactionsService {
  constructor(
    @Inject(WalletPrismaService) readonly db: PrismaClient,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
  ) {}

  async createTransaction(walletId: string, idempotencyKey: string, intent: Transfer) {
    const requestHash = createHash('sha256').update(canonical({ walletId, intent })).digest('hex');
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['idempotency', walletId, idempotencyKey]));
      const existing = await db.transaction.findFirst({
        where: { wallet_id: walletId, idempotency_key: idempotencyKey },
      });
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ConflictException('Idempotency key already used for a different request');
        return existing;
      }
      await db.$queryRaw`SELECT id FROM wallets WHERE id=${walletId}::uuid FOR UPDATE`;
      const wallet = await db.wallet.findFirst({ where: { id: walletId } });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.custody_role !== 'legacy')
        throw new ConflictException(
          'Custody wallets require an authorized sweep or withdrawal operation',
        );
      if (wallet.status !== 'ready') throw new ConflictException('Wallet address is not ready');
      if (wallet.chain !== intent.chain)
        throw new BadRequestException('Wallet and transaction chain mismatch');
      if (wallet.network !== networkFor(intent.chain, this.config))
        throw new ConflictException('Wallet belongs to a different configured network');
      if (
        await db.transaction.findFirst({
          where: { wallet_id: walletId, status: { in: pendingStatuses } },
        })
      )
        throw new ConflictException('Wallet has a pending transaction');
      const tx = await db.transaction.create({
        data: {
          id: randomUUID(),
          wallet_id: walletId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          intent: intent as Prisma.InputJsonValue,
          status: 'preparing',
        },
      });
      await enqueue(
        db,
        QUEUES.wallet,
        { type: 'transaction.prepare', transactionId: tx.id },
        `prepare-${tx.id}`,
      );
      return tx;
    });
  }

  async getTransaction(id: string) {
    const tx = await this.db.transaction.findFirst({ where: { id } });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  private snapshot(tx: {
    wallet: { chain: string; network: string };
    signed: unknown;
    prepared: unknown;
  }) {
    const prepared = tx.prepared as { lastValidBlockHeight?: number } | null;
    return broadcastSnapshotSchema.parse({
      chain: tx.wallet.chain,
      network: tx.wallet.network,
      signed: tx.signed,
      ...(tx.wallet.chain === 'solana'
        ? { lastValidBlockHeight: prepared?.lastValidBlockHeight }
        : {}),
    });
  }

  async requestBroadcast(id: string) {
    return this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const tx = await db.transaction.findFirst({
        where: { id },
        include: { wallet: true },
      });
      if (!tx) throw new NotFoundException('Transaction not found');
      if (tx.wallet.custody_role !== 'legacy')
        throw new ConflictException('Custody execution requires its bound reconciliation workflow');
      if (['queued', 'broadcasting', 'submitted', 'confirmed', 'failed'].includes(tx.status))
        return tx;
      if (!['signed', 'attention'].includes(tx.status) || !tx.signed)
        throw new ConflictException('Transaction is not signed');
      const updated = await db.transaction.update({
        where: { id },
        data: {
          status: 'queued',
          broadcast_generation: { increment: 1 },
          broadcast_revision: 0,
          last_error: null,
        },
      });
      await enqueue(
        db,
        QUEUES.broadcast,
        {
          type: 'broadcast.requested',
          snapshot: this.snapshot(tx),
          transactionId: id,
          generation: updated.broadcast_generation,
        },
        `broadcast-${id}-${updated.broadcast_generation}`,
      );
      return updated;
    });
  }

  async requestRefresh(id: string) {
    return this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const tx = await db.transaction.findFirst({
        where: { id },
        include: { wallet: true },
      });
      if (!tx) throw new NotFoundException('Transaction not found');
      if (tx.wallet.custody_role !== 'legacy')
        throw new ConflictException('Custody execution requires its bound reconciliation workflow');
      if (['confirmed', 'failed'].includes(tx.status)) return tx;
      if (!tx.signed || tx.status !== 'attention')
        throw new ConflictException(
          'Confirmation monitoring can only be restarted for transactions requiring attention',
        );
      await enqueue(
        db,
        QUEUES.broadcast,
        {
          type: 'broadcast.confirm',
          snapshot: this.snapshot(tx),
          transactionId: id,
          generation: tx.broadcast_generation,
          poll: 0,
          monitorId: randomUUID(),
        },
        `refresh-${id}-${randomUUID()}`,
      );
      return tx;
    });
  }
}
