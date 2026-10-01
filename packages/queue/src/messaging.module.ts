import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsOptions, ConnectionOptions } from 'bullmq';
import { queueConfig, QueueConfig } from './queue.config';
import { MessageAuth, QUEUES } from './messages';

export function connection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('Invalid Redis URL');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(parsed.pathname.slice(1) || 0),
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  };
}
export function jobOptions(retryDelayMs: number): JobsOptions {
  return {
    attempts: 8,
    backoff: { type: 'exponential', delay: retryDelayMs },
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: false,
  };
}
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: QueueConfig) => ({
        connection: connection(config.redisUrl),
        prefix: config.prefix,
        defaultJobOptions: jobOptions(config.retryDelayMs),
      }),
    }),
    BullModule.registerQueue(...Object.values(QUEUES).map((name) => ({ name }))),
  ],
  providers: [
    {
      provide: MessageAuth,
      inject: [queueConfig.KEY],
      useFactory: (config: QueueConfig) => new MessageAuth(config.authKey),
    },
  ],
  exports: [BullModule, MessageAuth],
})
export class MessagingModule {}
