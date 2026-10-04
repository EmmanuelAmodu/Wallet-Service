import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { PubSub, Message as PubSubMessage, Subscription } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  ActivityListenerConfig,
  activityListenerConfig,
} from './config/activity-listener.config.js';
import { MessageAuth, QUEUES } from '../../../packages/queue/src/messages.js';
import { processorActivitySchema } from '../../../packages/shared/src/activity-contracts.js';
import { exchangeDiscoverySchema } from '../../../packages/shared/src/exchange-discovery.js';

@Injectable()
export class ActivityPubSubService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ActivityPubSubService.name);
  private client?: PubSub;
  private subscription?: Subscription;

  constructor(
    @Inject(activityListenerConfig.KEY) private readonly config: ActivityListenerConfig,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @InjectQueue(QUEUES.activity) private readonly activities: Queue,
  ) {}

  onModuleInit() {
    this.client = new PubSub({
      projectId: this.config.pubsubProjectId,
      ...(this.config.pubsubApiEndpoint ? { apiEndpoint: this.config.pubsubApiEndpoint } : {}),
    });
    this.subscription = this.client.subscription(this.config.pubsubSubscription);
    this.subscription.on('message', (message) => void this.forward(message));
    this.subscription.on('error', (error) => {
      this.logger.error('Pub/Sub subscription error', error.stack);
    });
  }

  async onApplicationShutdown() {
    this.subscription?.removeAllListeners();
    await this.subscription?.close();
    await this.client?.close();
  }

  private async forward(message: PubSubMessage) {
    try {
      const rawPayload = message.data.toString('utf8');
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawPayload);
      } catch {
        await this.quarantine(message.id, 'Invalid JSON', rawPayload);
        message.ack();
        return;
      }
      const sourceEpoch =
        decoded && typeof decoded === 'object' && 'resetEpoch' in decoded
          ? decoded.resetEpoch
          : undefined;
      if (sourceEpoch !== this.auth.resetEpoch) {
        const reason =
          sourceEpoch === undefined
            ? 'Provider event is missing reset epoch'
            : 'Stale provider event reset epoch';
        await this.quarantine(message.id, reason, rawPayload);
        message.ack();
        return;
      }
      if (decoded && typeof decoded === 'object' && 'schemaVersion' in decoded) {
        const discovery = exchangeDiscoverySchema.safeParse(decoded);
        if (!discovery.success) {
          await this.quarantine(message.id, 'Invalid versioned exchange discovery', rawPayload);
          message.ack();
          return;
        }
        const jobId = `exchange-discovery-${createHash('sha256').update(message.id).digest('hex')}`;
        const payload = { type: 'exchange.discovery.received' as const, discovery: discovery.data };
        await this.activities.add(payload.type, this.auth.seal(payload, jobId), { jobId });
        message.ack();
        return;
      }
      const parsed = processorActivitySchema.safeParse(decoded);
      if (!parsed.success) {
        const reason = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        await this.quarantine(message.id, reason || 'Invalid activity payload', rawPayload);
        message.ack();
        return;
      }
      const jobId = `activity-${createHash('sha256').update(message.id).digest('hex')}`;
      const payload = {
        type: 'activity.received' as const,
        pubsubMessageId: message.id,
        activity: parsed.data,
      };
      await this.activities.add(payload.type, this.auth.seal(payload, jobId), { jobId });
      message.ack();
    } catch (error) {
      this.logger.error('Could not enqueue on-chain activity; requesting redelivery', error);
      message.nack();
    }
  }

  private async quarantine(pubsubMessageId: string, reason: string, rawPayload: string) {
    const digest = createHash('sha256').update(rawPayload).digest('hex');
    const jobId = `activity-invalid-${createHash('sha256').update(pubsubMessageId).digest('hex')}`;
    const payload = {
      type: 'activity.invalid' as const,
      pubsubMessageId,
      reason: reason.slice(0, 500),
      digest,
      payload: rawPayload.slice(0, 65536),
    };
    await this.activities.add(payload.type, this.auth.seal(payload, jobId), { jobId });
  }
}
