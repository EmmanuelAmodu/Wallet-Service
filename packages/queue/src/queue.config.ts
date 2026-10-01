import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../shared/src/config';
import { token } from '../../shared/src/security/tokens';

export const queueConfig = registerAs('queue', () => ({
  redisUrl: required('REDIS_URL'),
  prefix: process.env.QUEUE_PREFIX ?? 'waas',
  authKey: token(required('QUEUE_AUTH_KEY')),
  retryDelayMs: integerSetting('QUEUE_RETRY_DELAY_MS', 1000, 1, 86400000),
  outboxIntervalMs: integerSetting('OUTBOX_INTERVAL_MS', 500, 10, 86400000),
}));
export type QueueConfig = ConfigType<typeof queueConfig>;
