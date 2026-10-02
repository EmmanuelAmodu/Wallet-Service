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
import { Chain, chainSchema } from '../../../packages/shared/src/contracts.js';
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

const sourceNetworkAliases: Record<string, Chain> = {
  bsc: 'smartChain',
};

@Injectable()
export class ActivityWorkflowService {
  private readonly logger = new Logger(ActivityWorkflowService.name);

  constructor(
    private readonly rpc: ChainRpcService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @InjectQueue(QUEUES.activity) private readonly activityQueue: Queue,
    @InjectQueue(QUEUES.ledger) private readonly ledgerQueue: Queue,
    @Inject(activityListenerConfig.KEY) private readonly config: ActivityListenerConfig,
  ) {}

  async receive(activity: ProcessorActivity, pubsubMessageId: string, finalAttempt = false) {
    const { chain, transactionHash } = this.identity(activity);
    await this.checkFinality(activity, chain, transactionHash, 0, finalAttempt);
    this.logger.debug(`Accepted activity ${activity.identifier} from Pub/Sub ${pubsubMessageId}`);
  }

  async resumeFinality(
    activity: ProcessorActivity,
    poll: number,
    previousBlockHash?: string,
    finalAttempt = false,
  ) {
    const { chain, transactionHash } = this.identity(activity);
    const observation = await this.observeOrMarkAttention(
      activity,
      chain,
      transactionHash,
      finalAttempt,
    );
    if (!observation) return;
    if (observation.state === 'observed') {
      if (poll >= this.config.finalityMaxPolls) {
        await this.publishLedgerUpdate(
          activity,
          chain,
          transactionHash,
          'attention',
          observation,
          activity.balanceChanges,
        );
        this.logger.warn(`Finality polling exhausted for ${activity.identifier}`);
        return;
      }
      await this.publishLedgerUpdate(
        activity,
        chain,
        transactionHash,
        'observed',
        observation,
        activity.balanceChanges,
      );
      await this.scheduleFinality(activity, poll + 1, observation.blockHash ?? previousBlockHash);
      return;
    }
    await this.publishSettledActivity(activity, chain, transactionHash, observation);
  }

  private async checkFinality(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    poll: number,
    finalAttempt: boolean,
  ) {
    const observation = await this.observeOrMarkAttention(
      activity,
      chain,
      transactionHash,
      finalAttempt,
    );
    if (!observation) return;
    if (observation.state === 'observed') {
      await this.publishLedgerUpdate(
        activity,
        chain,
        transactionHash,
        'observed',
        observation,
        activity.balanceChanges,
      );
      await this.scheduleFinality(activity, poll + 1, observation.blockHash);
      return;
    }
    await this.publishSettledActivity(activity, chain, transactionHash, observation);
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
      await this.publishLedgerUpdate(
        activity,
        chain,
        transactionHash,
        'attention',
        {},
        activity.balanceChanges,
      );
      this.logger.error(`RPC retries exhausted for ${activity.identifier}`, error);
    }
  }

  private async publishSettledActivity(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    observation: ChainObservation,
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
    );
  }

  private async publishLedgerUpdate(
    activity: ProcessorActivity,
    chain: Chain,
    transactionHash: string,
    state: LedgerActivity['state'],
    observation: Pick<ChainObservation, 'blockHash' | 'blockHeight'>,
    sourceChanges: ProcessorActivity['balanceChanges'],
  ) {
    const ledgerActivity = ledgerActivitySchema.parse({
      identifier: activity.identifier,
      chain,
      network: this.rpc.networkIdentity(chain),
      transactionHash,
      sourceStatus: activity.status,
      state,
      completedAtTimestamp: activity.completedAtTimestamp,
      ...(observation.blockHash ? { blockHash: observation.blockHash } : {}),
      ...(observation.blockHeight ? { blockHeight: observation.blockHeight } : {}),
      changes: sourceChanges.flatMap((walletChanges) =>
        walletChanges.changes.map((change) => ({
          wallet: walletChanges.wallet,
          asset: this.normalizeAssetIdentifier(change.token, chain),
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
      delay: this.config.finalityPollMs,
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

  private normalizeAssetIdentifier(identifier: string, chain: Chain) {
    if (chain !== 'smartChain') return identifier;
    return identifier.replace(/^token:bsc:/, 'token:smartChain:');
  }

  private identity(activity: ProcessorActivity) {
    const [, sourceNetwork, ...hashParts] = activity.identifier.split(':');
    const chain =
      sourceNetwork &&
      (sourceNetworkAliases[sourceNetwork] ?? chainSchema.safeParse(sourceNetwork).data);
    const transactionHash = hashParts.join(':');
    if (!chain || !transactionHash)
      throw new ActionRejectedError('Unsupported activity identifier');
    return { chain, transactionHash };
  }
}
