import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export const userConfig = registerAs('user', () => ({
  databaseUrl:
    process.env.USER_DATABASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? required('USER_DATABASE_URL')
      : 'postgresql://users:users_local_only@127.0.0.1:5437/users'),
  domainId: (() => {
    const value = required('EXCHANGE_DOMAIN_ID');
    if (value.trim() !== value || !value.length || value.length > 128)
      throw new Error('Invalid configuration: EXCHANGE_DOMAIN_ID');
    return value;
  })(),
  host: process.env.USER_HOST ?? '127.0.0.1',
  port: integerSetting('USER_PORT', 3001, 1, 65535),
  hashConcurrency: integerSetting('USER_HASH_CONCURRENCY', 2, 1, 4),
  registrationWindowMs: integerSetting('USER_REGISTRATION_WINDOW_MS', 60000, 1000, 3600000),
  registrationIpLimit: integerSetting('USER_REGISTRATION_IP_LIMIT', 5, 1, 1000),
  registrationGlobalLimit: integerSetting('USER_REGISTRATION_GLOBAL_LIMIT', 30, 1, 10000),
  loginWindowMs: integerSetting('USER_LOGIN_WINDOW_MS', 60000, 1000, 3600000),
  loginIpLimit: integerSetting('USER_LOGIN_IP_LIMIT', 10, 1, 1000),
  loginGlobalLimit: integerSetting('USER_LOGIN_GLOBAL_LIMIT', 60, 1, 10000),
}));
export type UserConfig = ConfigType<typeof userConfig>;
