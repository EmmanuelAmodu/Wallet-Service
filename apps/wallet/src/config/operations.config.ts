import { registerAs } from '@nestjs/config';
import { integerSetting } from '../../../../packages/shared/src/config.js';
import { token } from '../../../../packages/shared/src/security/tokens.js';
export const operationsConfig = registerAs('operations', () => {
  const flag = process.env.ENABLE_OPERATIONS_MONITORING ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('Invalid ENABLE_OPERATIONS_MONITORING');
  const apiKey = process.env.OPERATIONS_API_KEY;
  if (apiKey) {
    token(apiKey);
    if (
      [
        process.env.WALLET_API_KEY,
        process.env.EXCHANGE_API_KEY,
        process.env.LEDGER_API_KEY,
        process.env.QUEUE_AUTH_KEY,
      ].includes(apiKey)
    )
      throw new Error('Operations needs a distinct credential');
  }
  return {
    enabled: flag === 'true',
    apiKey,
    actor: process.env.OPERATIONS_ACTOR ?? 'operations-service',
    intervalMs: integerSetting('OPERATIONS_MONITOR_INTERVAL_MS', 30000, 1000, 86400000),
    freshnessMs: integerSetting('OPERATIONS_SAMPLE_FRESHNESS_MS', 300000, 1000, 86400000),
    batchSize: integerSetting('OPERATIONS_MONITOR_BATCH_SIZE', 25, 1, 100),
  };
});
export type OperationsSettings = ReturnType<typeof operationsConfig>;
