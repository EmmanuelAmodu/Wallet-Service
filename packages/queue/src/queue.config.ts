import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../shared/src/config.js';
import { token } from '../../shared/src/security/tokens.js';
import { assertResetReady } from '../../shared/src/development-reset.js';

export function epochQueuePrefix(prefix: string, resetEpoch: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(prefix)) throw new Error('Invalid queue prefix');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resetEpoch)) throw new Error('Invalid reset epoch');
  return `${prefix}:${resetEpoch}`;
}

export const queueConfig = registerAs('queue', () => {
  assertResetReady();
  const resetEpoch = required('RESET_EPOCH');
  return {
    redisUrl: required('REDIS_URL'),
    resetEpoch,
    prefix: epochQueuePrefix(process.env.QUEUE_PREFIX ?? 'waas', resetEpoch),
    authKey: token(required('QUEUE_AUTH_KEY')),
    retryDelayMs: integerSetting('QUEUE_RETRY_DELAY_MS', 1000, 1, 86400000),
    outboxIntervalMs: integerSetting('OUTBOX_INTERVAL_MS', 500, 10, 86400000),
  };
});
export type QueueConfig = ConfigType<typeof queueConfig>;
