import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';
import { token } from '../../../../packages/shared/src/security/tokens.js';

export const ledgerConfig = registerAs('ledger', () => ({
  databaseUrl:
    process.env.LEDGER_DATABASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? required('LEDGER_DATABASE_URL')
      : 'postgresql://ledger:ledger_local_only@127.0.0.1:5434/ledger'),
  apiKey: (() => {
    const queueAuthKey = required('QUEUE_AUTH_KEY');
    const key = token(
      process.env.LEDGER_API_KEY ??
        (process.env.NODE_ENV === 'production' ? required('LEDGER_API_KEY') : queueAuthKey),
    );
    if (process.env.NODE_ENV === 'production' && key === queueAuthKey)
      throw new Error('Use a distinct ledger API key in production');
    return key;
  })(),
  host: process.env.LEDGER_HOST ?? '127.0.0.1',
  port: integerSetting('LEDGER_PORT', 3010, 1, 65535),
}));
export type LedgerConfig = ConfigType<typeof ledgerConfig>;
