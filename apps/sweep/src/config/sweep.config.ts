import { registerAs } from '@nestjs/config';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export const sweepConfig = registerAs('sweep', () => {
  const native = process.env.ENABLE_NATIVE_SWEEPS ?? 'false';
  if (native !== 'true' && native !== 'false')
    throw new Error('ENABLE_NATIVE_SWEEPS must be true or false');
  const tokens = process.env.ENABLE_TOKEN_EXECUTION ?? 'false';
  if (!['true','false'].includes(tokens)) throw new Error('ENABLE_TOKEN_EXECUTION must be true or false');
  return {
    databaseUrl:
      process.env.SWEEP_DATABASE_URL ??
      (process.env.NODE_ENV === 'production'
        ? required('SWEEP_DATABASE_URL')
        : 'postgresql://sweep:sweep_local_only@127.0.0.1:5436/sweep'),
    domainId: required('EXCHANGE_DOMAIN_ID'),
    enableNativeSweeps: native === 'true',
    enableTokenSweeps: tokens === 'true',
    policyVersion: process.env.EXCHANGE_FINANCIAL_POLICY_VERSION ?? 'exchange-financial-v1',
    retryDelayMs: integerSetting('SWEEP_RETRY_DELAY_MS', 60000, 100, 86400000),
    reconciliationIntervalMs: integerSetting('SWEEP_RECONCILIATION_MS', 15000, 100, 86400000),
  };
});
