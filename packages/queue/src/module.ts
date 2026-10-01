import { DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsOptions, ConnectionOptions } from 'bullmq';
import { required } from '../../shared/src/http';
import { integerSetting } from '../../shared/src/config';
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
export function jobOptions(): JobsOptions {
  return {
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: integerSetting('QUEUE_RETRY_DELAY_MS', 1000, 1, 86400000),
    },
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: false,
  };
}
export function queuePrefix() {
  return process.env.QUEUE_PREFIX ?? 'waas';
}
@Module({})
export class MessagingModule {
  static register(): DynamicModule {
    return {
      module: MessagingModule,
      imports: [
        BullModule.forRoot({
          connection: connection(required('REDIS_URL')),
          prefix: queuePrefix(),
          defaultJobOptions: jobOptions(),
        }),
        BullModule.registerQueue(...Object.values(QUEUES).map((name) => ({ name }))),
      ],
      providers: [
        { provide: MessageAuth, useFactory: () => new MessageAuth(required('QUEUE_AUTH_KEY')) },
      ],
      exports: [BullModule, MessageAuth],
    };
  }
}
