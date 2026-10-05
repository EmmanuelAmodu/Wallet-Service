import { registerAs } from '@nestjs/config';
import { required } from '../../../../packages/shared/src/config.js';

export const sweepConfig = registerAs('sweep', () => ({
  databaseUrl:
    process.env.SWEEP_DATABASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? required('SWEEP_DATABASE_URL')
      : 'postgresql://sweep:sweep_local_only@127.0.0.1:5436/sweep'),
  domainId: required('EXCHANGE_DOMAIN_ID'),
}));
