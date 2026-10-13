import { operationsMetrics, ageMetric } from '../../../../packages/queue/src/operations-metrics.js';
import { BroadcastPrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '.prisma/broadcast-client';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { lock, lockTransaction } from '../../../../packages/database/src/locks.js';
import {
  broadcastSnapshotSchema,
  canonical,
  Message,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import { BroadcastRpcService } from './broadcast-rpc.service.js';

import { broadcastConfig, BroadcastConfig } from '../config/broadcast.config.js';
import {
  NativeSweepPlanner,
  NativeSweepObservation,
} from '../../../../packages/chain/src/native-sweep-planner.js';
import {
  executionRequestDigest,
  verifySignerAttestation,
} from '../../../../packages/shared/src/execution-authorization.js';
import { z } from 'zod';
import { signSchema } from '../../../../packages/shared/src/contracts.js';
import {
  TokenPlanner,
  TokenPreparation,
  validateTokenPreparation,
} from '../../../../packages/chain/src/token-planner.js';
import { TokenObserver } from '../../../../packages/chain/src/token-observer.js';

type Action = Extract<Message, { type: 'broadcast.requested' | 'broadcast.confirm' }>;
const active = ['queued', 'broadcasting', 'submitted', 'attention'];
@Injectable()
export class BroadcastService {
  constructor(
    @Inject(BroadcastPrismaService) private readonly db: BroadcastPrismaService,
    @Inject(BroadcastRpcService) private readonly rpc: BroadcastRpcService,
    @Inject(broadcastConfig.KEY) private readonly config: BroadcastConfig,
    @Optional() private readonly planner?: NativeSweepPlanner,
  ) {}

  async execute(message: Message, finalAttempt: boolean) {
    if (message.type === 'operations.repair.requested.v1') {
      if (
        message.domainId !== this.config.domainId ||
        (this.config.resetEpoch && message.resetEpoch !== this.config.resetEpoch)
      )
        throw new ActionRejectedError('Broadcast recovery scope mismatch');
      const rows = await this.db.transaction.findMany({
        where: {
          domain_id: message.domainId,
          reset_epoch: message.resetEpoch,
          status: { in: ['queued', 'broadcasting', 'submitted', 'attention'] },
        },
        orderBy: { updated_at: 'asc' },
        take: 100,
      });
      for (const row of rows) {
        try {
          await this.execute(
            {
              type: 'broadcast.confirm',
              transactionId: row.id,
              generation: row.broadcast_generation,
              poll: 0,
            },
            false,
          );
        } catch {
          /* Keep uncertain outcomes; do not submit replacement bytes. */
        }
      }
      const metrics = [
        { name: 'broadcast_uncertain', value: String(rows.length), labels: {} },
        ageMetric('broadcast_oldest_age_ms', rows),
      ];
      await this.db.$transaction((tx) =>
        enqueue(
          tx,
          QUEUES.wallet,
          operationsMetrics(message, 'broadcast', metrics),
          `operations-broadcast:${message.eventId}`,
        ),
      );
      return;
    }
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
        const snapshot = broadcastSnapshotSchema.parse(action.snapshot);
        this.verifyExecution(action.transactionId, snapshot);
        await db.transaction.create({
          data: {
            id: action.transactionId,
            snapshot: action.snapshot,
            broadcast_generation: action.generation,
            status: 'queued',
            ...(snapshot.execution
              ? {
                  domain_id: snapshot.execution.domainId,
                  reset_epoch: snapshot.execution.resetEpoch,
                  operation_id: snapshot.execution.operationId,
                  attempt_id: snapshot.execution.attemptId,
                  request_digest: snapshot.execution.requestDigest,
                  preparation_digest: snapshot.execution.preparationDigest,
                }
              : {}),
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
      operation_id: string | null;
      attempt_id: string | null;
      request_digest: string | null;
      preparation_digest: string | null;
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
        ...(tx.operation_id
          ? {
              execution: {
                operationId: tx.operation_id,
                attemptId: tx.attempt_id!,
                requestDigest: tx.request_digest!,
                preparationDigest: tx.preparation_digest!,
              },
            }
          : {}),
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
    this.verifyExecution(action.transactionId, snapshot);
    const { chain, signed } = snapshot;
    if (snapshot.network !== networkFor(chain, this.config))
      throw new ActionRejectedError('Configured network differs from wallet network');
    if (snapshot.execution) {
      await this.handleCustody(action, tx, snapshot);
      return;
    }
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
    observation?: NativeSweepObservation,
  ) {
    await this.db.$transaction(async (db) => {
      await lockTransaction(db, action.transactionId);
      const tx = await db.transaction.findUnique({ where: { id: action.transactionId } });
      if (!tx || tx.broadcast_generation !== action.generation || !active.includes(tx.status))
        return;
      const updated = await db.transaction.update({
        where: { id: tx.id },
        data: {
          ...(status ? { status } : {}),
          last_error: null,
          revision: { increment: 1 },
          ...(observation?.blockHash && observation.blockHeight
            ? {
                observed_block_hash: observation.blockHash,
                observed_block_height: observation.blockHeight,
              }
            : {}),
          ...(observation?.actualFeeUnits ? { actual_fee_units: observation.actualFeeUnits } : {}),
        },
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

  private verifyExecution(
    transactionId: string,
    snapshot: z.infer<typeof broadcastSnapshotSchema>,
  ): void {
    const execution = snapshot.execution;
    if (!execution) {
      if (
        this.config.custodyMode ||
        this.config.nativeSweepsEnabled ||
        this.config.nativeWithdrawalsEnabled ||
        this.config.tokenExecutionEnabled
      )
        throw new ActionRejectedError(
          'Native custody mode requires an independently attested execution',
        );
      return;
    }
    if (
      !(execution.tokenPreparation || execution.preparedRequest.wallet.account === 1
        ? this.config.tokenExecutionEnabled
        : execution.preparedRequest.wallet.account === 0
          ? this.config.nativeWithdrawalsEnabled
          : this.config.nativeSweepsEnabled) ||
      !this.config.executionSignerPublicKey
    )
      throw new ActionRejectedError('Native custody broadcasting is disabled');
    try {
      if (execution.tokenPreparation) {
        validateTokenPreparation(execution.tokenPreparation as TokenPreparation);
        if (canonical(execution.preparedRequest) !== canonical(execution.tokenPreparation.request))
          throw new Error('Token preparation snapshot mismatch');
      }
      if (
        execution.domainId !== this.config.domainId ||
        execution.resetEpoch !== this.config.resetEpoch ||
        execution.preparedRequest.wallet.chain !== snapshot.chain ||
        execution.preparedRequest.transaction.chain !== snapshot.chain ||
        execution.preparedRequest.wallet.network !== snapshot.network ||
        (execution.tokenPreparation
          ? execution.tokenPreparation.preparedDigest
          : executionRequestDigest(signSchema.parse(execution.preparedRequest))) !==
          execution.preparationDigest
      )
        throw new Error('Execution snapshot binding mismatch');
      if (
        snapshot.chain === 'solana' &&
        execution.preparedRequest.transaction.chain === 'solana' &&
        snapshot.lastValidBlockHeight !== execution.preparedRequest.transaction.lastValidBlockHeight
      )
        throw new Error('Solana snapshot validity mismatch');
      const { signerAttestation, ...binding } = execution;
      const unsigned = {
        type: 'transaction.custody.signed',
        transactionId,
        operationId: binding.operationId,
        attemptId: binding.attemptId,
        requestDigest: binding.requestDigest,
        preparationDigest: binding.preparationDigest,
        signed: snapshot.signed,
      };
      const claims = verifySignerAttestation(
        signerAttestation,
        unsigned,
        this.config.executionSignerPublicKey,
      );
      if (
        claims.domainId !== execution.domainId ||
        claims.resetEpoch !== execution.resetEpoch ||
        claims.status !== 'signed'
      )
        throw new Error('Signer execution identity mismatch');
    } catch {
      throw new ActionRejectedError(
        'Independent signer attestation does not authorize this broadcast',
      );
    }
  }

  private async handleCustody(
    action: Action,
    tx: { observed_block_hash: string | null; observed_block_height: string | null },
    snapshot: z.infer<typeof broadcastSnapshotSchema>,
  ) {
    const execution = snapshot.execution!;
    if (!['ethereum', 'bitcoin', 'solana'].includes(snapshot.chain))
      throw new ActionRejectedError('Native custody chain is unsupported');
    if (action.type === 'broadcast.requested') {
      if (!this.config.allowBroadcast) throw new ActionRejectedError('Broadcasting is disabled');
      await this.change(action, { status: 'broadcasting', broadcast_attempts: { increment: 1 } });
    }
    const planner = this.planner ?? new NativeSweepPlanner(this.rpc);
    const token = execution.tokenPreparation as TokenPreparation | undefined;
    const observed = token
      ? await new TokenObserver(this.rpc).observe(
          token,
          snapshot.signed,
          tx.observed_block_hash && tx.observed_block_height
            ? { blockHash: tx.observed_block_hash, blockHeight: tx.observed_block_height }
            : undefined,
        )
      : await planner.observe({
          chain: snapshot.chain as 'ethereum' | 'bitcoin' | 'solana',
          network: snapshot.network,
          hash: snapshot.signed.txHash,
          request: signSchema.parse(execution.preparedRequest),
          signed: snapshot.signed,
          ...(tx.observed_block_hash && tx.observed_block_height
            ? {
                priorInclusion: {
                  blockHash: tx.observed_block_hash,
                  blockHeight: tx.observed_block_height,
                },
              }
            : {}),
        });
    this.validateObservation(observed);
    if (observed.state === 'confirmed' || observed.state === 'failed') {
      await this.record(action, observed.state, undefined, observed);
      return;
    }
    if (observed.state === 'reverted')
      throw new ActionRejectedError(
        'Custody inclusion reverted; authoritative reconciliation required before reuse',
      );
    if (action.type === 'broadcast.confirm') {
      if (action.poll >= this.config.maxPolls)
        throw new ActionRejectedError(
          'Custody monitoring exhausted; hold the attempt for authoritative reconciliation',
        );
      await this.record(action, undefined, action.poll + 1, observed);
      return;
    }
    if (observed.blockHash) {
      await this.record(action, 'submitted', 0, observed);
      return;
    }
    if (snapshot.chain === 'solana') {
      const height = await this.rpc.call('solana', 'getBlockHeight', [{ commitment: 'finalized' }]);
      if (typeof height !== 'number' || !Number.isSafeInteger(height))
        throw new Error('Invalid Solana block height');
      if (height > snapshot.lastValidBlockHeight!)
        throw new ActionRejectedError(
          'Solana blockhash expired; hold the signed attempt for canonical reconciliation',
        );
    }
    if (token) {
      await new TokenPlanner(this.rpc).revalidate(token, true);
      if (snapshot.chain === 'solana') {
        const simulation = z
          .object({ value: z.object({ err: z.null() }) })
          .parse(
            await this.rpc.call('solana', 'simulateTransaction', [
              snapshot.signed.raw,
              { encoding: 'base64', sigVerify: true, commitment: 'finalized' },
            ]),
          );
        if (simulation.value.err !== null) throw new ActionRejectedError('Token simulation failed');
      }
    } else await this.rpc.preflight(snapshot.chain, snapshot.signed);
    await this.rpc.broadcast(snapshot.chain, snapshot.signed);
    await this.record(action, 'submitted', 0, observed);
  }

  private validateObservation(observed: NativeSweepObservation): void {
    if ((observed.blockHash === undefined) !== (observed.blockHeight === undefined))
      throw new Error('Incomplete canonical inclusion evidence');
    if (observed.blockHeight !== undefined && !/^(0|[1-9][0-9]*)$/.test(observed.blockHeight))
      throw new Error('Invalid canonical inclusion height');
    if (
      observed.actualFeeUnits !== undefined &&
      (!/^(0|[1-9][0-9]{0,77})$/.test(observed.actualFeeUnits) ||
        BigInt(observed.actualFeeUnits) >= 1n << 256n)
    )
      throw new Error('Invalid canonical fee evidence');
    if (
      (observed.state === 'confirmed' || observed.state === 'failed') &&
      (!observed.blockHash ||
        observed.blockHeight === undefined ||
        observed.actualFeeUnits === undefined)
    )
      throw new Error('Canonical terminal outcome requires inclusion and actual fees');
  }
}
