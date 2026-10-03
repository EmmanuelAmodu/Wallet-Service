import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export const activityListenerConfig = registerAs('activityListener', () => ({
  pubsubProjectId:
    process.env.PUBSUB_PROJECT_ID ??
    (process.env.NODE_ENV === 'production' ? required('PUBSUB_PROJECT_ID') : 'wallet-local'),
  pubsubSubscription:
    process.env.PUBSUB_SUBSCRIPTION ??
    (process.env.NODE_ENV === 'production' ? required('PUBSUB_SUBSCRIPTION') : 'wallet-activity'),
  pubsubApiEndpoint:
    process.env.PUBSUB_API_ENDPOINT ??
    (process.env.NODE_ENV === 'production' ? undefined : '127.0.0.1:8086'),
  finalityPollMs: integerSetting('ACTIVITY_FINALITY_POLL_MS', 30000, 100, 86400000),
  finalityMaxPolls: integerSetting('ACTIVITY_FINALITY_MAX_POLLS', 120, 1, 10000),
  reconciliationPollMs: integerSetting('ACTIVITY_RECONCILIATION_POLL_MS', 300000, 100, 86400000),
}));

export type ActivityListenerConfig = ConfigType<typeof activityListenerConfig>;
