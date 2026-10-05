import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting } from '../../../../packages/shared/src/config.js';
import {
  tokenIdentitySettings,
  tokenPemSetting,
} from '../../../../packages/shared/src/security/token-config.js';

export const userAuthConfig = registerAs('userAuth', () => ({
  ...tokenIdentitySettings(),
  privateKey: tokenPemSetting('AUTH_TOKEN_PRIVATE_KEY'),
  lifetimeSeconds: integerSetting('AUTH_ACCESS_TOKEN_TTL_SECONDS', 900, 60, 3600),
}));
export type UserAuthSettings = ConfigType<typeof userAuthConfig>;
