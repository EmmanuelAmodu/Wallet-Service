import { BroadcastPrismaService } from '../prisma/prisma.service';
import { Prisma } from '.prisma/broadcast-client';
import { Inject, Injectable } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error';
import { lock, lockTransaction } from '../../../../packages/database/src/locks';
import {
  broadcastSnapshotSchema,
  canonical,
  Message,
  QUEUES,
} from '../../../../packages/queue/src/messages';
import { enqueue } from '../../../../packages/queue/src/outbox.service';
import { networkFor } from '../../../../packages/chain/src/config';
import { BroadcastRpcService } from './broadcast-rpc.service';

import { broadcastConfig, BroadcastConfig } from '../config/broadcast.config';

type Action = Extract<Message, { type: 'broadcast.requested' | 'broadcast.confirm' }>;
const active = ['queued', 'broadcasting', 'submitted', 'attention'];
@Injectable()
export class BroadcastService {
  constructor(
    @Inject(BroadcastPrismaService) private readonly db: BroadcastPrismaService,
    @Inject(BroadcastRpcService) private readonly rpc: BroadcastRpcService,
    @Inject(broadcastConfig.KEY) private readonly config: BroadcastConfig,
  ) {}
  async execute(message: Message, finalAttempt: boolean) {
    if (message.type !== 'broadcast.requested' && message.type !== 'broadcast.confirm')
      throw new ActionRejectedError('Unsupported broadcast action');
    try {
      await this.accept(message);
      await this.handle(message);
    } catch (error) {
      const exhausted = error instanceof ActionRejectedError || finalAttempt;
      await this.change(message, {
        ...(exhausted ? { status: 'attention' } : {}),
        last_error: exhausted
          ? 'Broadcast/confirmation action stopped; review failed queue job and retry or refresh this transaction'
          : 'RPC outcome uncertain; retry will reconcile the same transaction hash',
      });
      if (error instanceof ActionRejectedError) throw error;
      throw new Error('Broadcast/confirmation RPC operation failed', { cause: error });
    }
  }
  private async accept(action: Action) {
    await this.db.$transaction(async (db) => {
      await lock(db, `broadcast-${action.transactionId}`);
      await lockTransaction(db, action.transactionId);
      const tx = await db.transaction.findUnique({ where: { id: action.transactionId } });
      if (tx && action.generation < tx.broadcast_generation) return;
      if (!tx) {
        if (!action.snapshot) throw new Error('Broadcast snapshot not received yet');
        await db.transaction.create({
          data: {
            id: action.transactionId,
            snapshot: action.snapshot,
            broadcast_generation: action.generation,
            status: 'queued',
          },
        });
      } else {
        if (action.snapshot && canonical(tx.snapshot) !== canonical(action.snapshot))
          throw new ActionRejectedError('Signed broadcast payload is immutable');
        if (action.generation > tx.broadcast_generation) {
          if (!action.snapshot) throw new Error('New generation snapshot not received yet');
          const updated = await db.transaction.update({
            where: { id: tx.id },
            data: {
              broadcast_generation: action.generation,
              status: ['confirmed', 'failed'].includes(tx.status) ? tx.status : 'queued',
              revision: { increment: 1 },
              last_error: null,
            },
          });
          await this.emit(db, updated);
        }
      }
    });
  }
  private async emit(
    db: Prisma.TransactionClient,
    tx: {
      id: string;
      broadcast_generation: number;
      revision: number;
      status: string;
      broadcast_attempts: number;
      last_error: string | null;
    },
  ) {
    const status = tx.status as Extract<Message, { type: 'broadcast.updated' }>['status'];
    await enqueue(
      db,
      QUEUES.wallet,
      {
        type: 'broadcast.updated',
        transactionId: tx.id,
        generation: tx.broadcast_generation,
        revision: tx.revision,
        status,
        attempts: tx.broadcast_attempts,
        lastError: tx.last_error,
      },
      `broadcast-result-${tx.id}-${tx.broadcast_generation}-${tx.revision}`,
    );
  }
  private async change(action: Action, data: Prisma.TransactionUpdateInput) {
    await this.db.$transaction(async (db) => {
      await lockTransaction(db, action.transactionId);
      const tx = await db.transaction.findUnique({ where: { id: action.transactionId } });
      if (!tx || tx.broadcast_generation !== action.generation || !active.includes(tx.status))
        return;
      const updated = await db.transaction.update({
        where: { id: tx.id },
        data: {
          ...data,
          revision: { increment: 1 },
        },
      });
      await this.emit(db, updated);
    });
  }
  private async handle(action: Action) {
    const tx = await this.db.transaction.findUnique({
      where: { id: action.transactionId },
    });
    if (!tx || tx.broadcast_generation !== action.generation || !active.includes(tx.status)) return;
    const snapshot = broadcastSnapshotSchema.parse(tx.snapshot);
    const { chain, signed } = snapshot;
    if (snapshot.network !== networkFor(chain, this.config))
      throw new ActionRejectedError('Configured network differs from wallet network');
    if (action.type === 'broadcast.requested') {
      if (!this.config.allowBroadcast) throw new ActionRejectedError('Broadcasting is disabled');
      await this.change(action, { status: 'broadcasting', broadcast_attempts: { increment: 1 } });
    }
    // Lookup before every send handles acceptance followed by a lost RPC response.
    const observed = await this.rpc.status(chain, signed.txHash);
    if (observed === 'confirmed' || observed === 'failed') {
      await this.record(action, observed);
      return;
    }
    if (action.type === 'broadcast.confirm') {
      if (action.poll >= this.config.maxPolls)
        throw new ActionRejectedError(
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
      const height = await this.rpc.call(chain, 'getBlockHeight', [{ commitment: 'finalized' }]);
      if (typeof height !== 'number' || !Number.isSafeInteger(height))
        throw new Error('Invalid block height');
      if (height > snapshot.lastValidBlockHeight!)
        throw new ActionRejectedError(
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
      const updated = await db.transaction.update({
        where: { id: tx.id },
        data: { ...(status ? { status } : {}), last_error: null, revision: { increment: 1 } },
      });
      await this.emit(db, updated);
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
