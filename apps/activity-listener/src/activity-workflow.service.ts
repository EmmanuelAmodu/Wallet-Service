import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { ActionRejectedError } from '../../../packages/shared/src/action-rejected.error.js';
import {
  LedgerActivity,
  ledgerActivitySchema,
  ProcessorActivity,
} from '../../../packages/shared/src/activity-contracts.js';
import { Chain, resolveChainIdentifier } from '../../../packages/shared/src/contracts.js';
import {
  ChainRpcService,
  ChainObservation,
} from '../../../packages/chain/src/chain-rpc.service.js';
import { canonical, MessageAuth, QUEUES } from '../../../packages/queue/src/messages.js';
import {
  ActivityListenerConfig,
  activityListenerConfig,
} from './config/activity-listener.config.js';
import { Inject } from '@nestjs/common';

@Injectable()
export class ActivityWorkflowService {
  private readonly logger = new Logger(ActivityWorkflowService.name);
  private sequenceCommandRegistered = false;

  constructor(
    private readonly rpc: ChainRpcService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @InjectQueue(QUEUES.activity) private readonly activityQueue: Queue,
    @InjectQueue(QUEUES.ledger) private readonly ledgerQueue: Queue,
    @Inject(activityListenerConfig.KEY) private readonly config: ActivityListenerConfig,
  ) {}

  async receive(activity: ProcessorActivity, pubsubMessageId: string, finalAttempt = false) {
    const { chain, transactionHash } = this.identity(activity);
    const observationSequence = await this.nextObservationSequence(activity.identifier);
    await this.checkFinality(
      activity,
      chain,
      transactionHash,
      0,
      undefined,
      observationSequence,
      finalAttempt,
    );
    this.logger.debug(`Accepted activity ${activity.identifier} from Pub/Sub ${pubsubMessageId}`);
  }

  async resumeFinality(
    activity: ProcessorActivity,
    poll: number,
    previousBlockHash?: string,
    finalAttempt = false,
  ) {
    const { chain, transactionHash } = this.identity(activity);
    const observationSequence = await this.nextObservationSequence(activity.identifier);
    const observation = await this.observeOrMarkAttention(
      activity,
      chain,
      transactionHash,
      finalAttempt,
    );
    if (!observation) {
      await this.publishAttention(activity, chain, transactionHash, observationSequence);
      await this.scheduleFinality(activity, poll + 1, previousBlockHash);
      return;
    }
    await this.publishObservation(
      activity,
      chain,
      transactionHash,
      poll,
      previousBlockHash,
      observation,
      observationSequence,
    );
  }

  private async checkFinality(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    poll: number,
    previousBlockHash: string | undefined,
    observationSequence: string,
    finalAttempt: boolean,
  ) {
    const observation = await this.observeOrMarkAttention(
      activity,
      chain,
      transactionHash,
      finalAttempt,
    );
    if (!observation) {
      await this.publishAttention(activity, chain, transactionHash, observationSequence);
      await this.scheduleFinality(activity, poll + 1, previousBlockHash);
      return;
    }
    await this.publishObservation(
      activity,
      chain,
      transactionHash,
      poll,
      previousBlockHash,
      observation,
      observationSequence,
    );
  }

  private async publishAttention(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    observationSequence: string,
  ) {
    await this.publishLedgerUpdate(
      activity,
      chain,
      transactionHash,
      'attention',
      {},
      activity.balanceChanges,
      observationSequence,
    );
    this.logger.warn(`Finality polling requires recovery for ${activity.identifier}`);
  }

  private async publishObservation(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    poll: number,
    previousBlockHash: string | undefined,
    observation: ChainObservation,
    observationSequence: string,
  ) {
    const current =
      previousBlockHash &&
      observation.state === 'observed' &&
      observation.transactionFound === false
        ? { ...observation, state: 'reverted' as const }
        : observation;
    const canonicalReconciliation = previousBlockHash !== undefined || current.state === 'reverted';

    if (current.state === 'observed') {
      const state = poll >= this.config.finalityMaxPolls ? 'attention' : 'observed';
      await this.publishLedgerUpdate(
        activity,
        chain,
        transactionHash,
        state,
        current,
        activity.balanceChanges,
        observationSequence,
        canonicalReconciliation,
      );
      if (state === 'attention')
        this.logger.warn(`Finality polling requires recovery for ${activity.identifier}`);
    } else {
      await this.publishSettledActivity(
        activity,
        chain,
        transactionHash,
        current,
        observationSequence,
        canonicalReconciliation,
      );
    }

    await this.scheduleFinality(activity, poll + 1, current.blockHash ?? previousBlockHash);
  }

  private async observeOrMarkAttention(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    finalAttempt: boolean,
  ): Promise<ChainObservation | undefined> {
    try {
      return await this.rpc.observeTransaction(chain, transactionHash);
    } catch (error) {
      if (!finalAttempt) throw error;
      this.logger.error(`RPC retries exhausted for ${activity.identifier}`, error);
      return undefined;
    }
  }

  private async publishSettledActivity(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    observation: ChainObservation,
    observationSequence: string,
    canonicalReconciliation: boolean,
  ) {
    const changes =
      observation.state === 'failed'
        ? this.failedFeeChanges(activity, chain, observation.feeAmount)
        : observation.state === 'reverted'
          ? []
          : activity.balanceChanges;
    await this.publishLedgerUpdate(
      activity,
      chain,
      transactionHash,
      observation.state,
      observation,
      changes,
      observationSequence,
      canonicalReconciliation,
    );
  }

  private async nextObservationSequence(identifier: string) {
    const sequenceKey = this.ledgerQueue.toKey(
      `activity-sequence:${createHash('sha256').update(identifier).digest('hex')}`,
    );
    const redis = await this.ledgerQueue.getBackend().client;
    if (!this.sequenceCommandRegistered) {
      redis.defineCommand('nextActivitySequence', {
        numberOfKeys: 1,
        lua: `
          local current = redis.call('GET', KEYS[1])
          local baseline = ARGV[1]
          if not current or #current < #baseline or (#current == #baseline and current < baseline) then
            redis.call('SET', KEYS[1], baseline)
          end
          return tostring(redis.call('INCR', KEYS[1]))
        `,
      });
      this.sequenceCommandRegistered = true;
    }
    const sequence = await redis.runCommand('nextActivitySequence', [
      sequenceKey,
      String(Date.now()),
    ]);
    if (typeof sequence !== 'string' && typeof sequence !== 'number')
      throw new Error('Redis returned an invalid activity sequence');
    return String(sequence);
  }

  private async publishLedgerUpdate(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    state: LedgerActivity['state'],
    observation: Pick<ChainObservation, 'blockHash' | 'blockHeight'>,
    sourceChanges: ProcessorActivity['balanceChanges'],
    observationSequence: string,
    canonicalReconciliation = false,
  ) {
    const ledgerActivity = ledgerActivitySchema.parse({
      identifier: activity.identifier,
      chain,
      network: this.rpc.networkIdentity(chain),
      transactionHash,
      sourceStatus: activity.status,
      state,
      completedAtTimestamp: activity.completedAtTimestamp,
      observationSequence,
      canonicalReconciliation,
      ...(observation.blockHash ? { blockHash: observation.blockHash } : {}),
      ...(observation.blockHeight ? { blockHeight: observation.blockHeight } : {}),
      changes: sourceChanges.flatMap((walletChanges) =>
        walletChanges.changes.map((change) => ({
          wallet: walletChanges.wallet,
          asset: this.normalizeAssetIdentifier(change.token),
          amount: change.amount,
        })),
      ),
    });
    const jobId = `ledger-${createHash('sha256').update(canonical(ledgerActivity)).digest('hex')}`;
    const payload = { type: 'ledger.activity.update' as const, activity: ledgerActivity };
    await this.ledgerQueue.add(payload.type, this.auth.seal(payload, jobId), { jobId });
  }

  private async scheduleFinality(activity: ProcessorActivity, poll: number, blockHash?: string) {
    const payload = {
      type: 'activity.check-finality' as const,
      activity,
      poll,
      ...(blockHash ? { blockHash } : {}),
    };
    const jobId = `activity-check-${createHash('sha256')
      .update(`${activity.identifier}:${blockHash ?? 'unmined'}:${poll}`)
      .digest('hex')}`;
    await this.activityQueue.add(payload.type, this.auth.seal(payload, jobId), {
      jobId,
      delay:
        poll > this.config.finalityMaxPolls
          ? this.config.reconciliationPollMs
          : this.config.finalityPollMs,
    });
  }

  private failedFeeChanges(activity: ProcessorActivity, chain: Chain, feeAmount?: string) {
    const resolvedFee =
      feeAmount ??
      (chain === 'solana' && Number.isSafeInteger(activity.fee.amount) && activity.fee.amount >= 0
        ? String(activity.fee.amount)
        : undefined);
    if (resolvedFee === undefined || !activity.fee.feePayer.length) return [];
    const totalFee = BigInt(resolvedFee);
    const feePayers = activity.fee.feePayer;
    const baseShare = totalFee / BigInt(feePayers.length);
    const remainder = totalFee % BigInt(feePayers.length);
    return feePayers.map((wallet, index) => ({
      wallet,
      changes: [
        {
          token: `token:${chain}:native`,
          amount: (-(baseShare + (BigInt(index) < remainder ? 1n : 0n))).toString(),
        },
      ],
    }));
  }

  private normalizeAssetIdentifier(identifier: string) {
    const match = /^token:([^:]+):/.exec(identifier);
    const tokenChain = match && resolveChainIdentifier(match[1]);
    return tokenChain ? identifier.replace(/^token:[^:]+:/, `token:${tokenChain}:`) : identifier;
  }

  private identity(activity: ProcessorActivity) {
    const [, sourceNetwork, ...hashParts] = activity.identifier.split(':');
    const chain = sourceNetwork && resolveChainIdentifier(sourceNetwork);
    const transactionHash = hashParts.join(':');
    if (!chain || !transactionHash)
      throw new ActionRejectedError('Unsupported activity identifier');
    return { chain, transactionHash };
  }
}
