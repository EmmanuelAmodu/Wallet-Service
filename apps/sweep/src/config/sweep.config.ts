import { registerAs } from '@nestjs/config';
import { required } from '../../../../packages/shared/src/config.js';

export const sweepConfig = registerAs('sweep', () => ({
  databaseUrl:
    process.env.SWEEP_DATABASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? required('SWEEP_DATABASE_URL')
      : 'postgresql://sweep:sweep_local_only@127.0.0.1:5436/sweep'),
  domainId: required('EXCHANGE_DOMAIN_ID'),
  enableNativeSweeps: process.env.ENABLE_NATIVE_SWEEPS === 'true',
  policyVersion: process.env.EXCHANGE_FINANCIAL_POLICY_VERSION ?? 'exchange-financial-v1',
  retryDelayMs: 60000,
  reconciliationIntervalMs: 15000,
}));
