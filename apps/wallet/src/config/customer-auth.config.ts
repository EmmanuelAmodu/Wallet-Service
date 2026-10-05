import { registerAs, ConfigType } from '@nestjs/config';
import {
  tokenIdentitySettings,
  tokenPemSetting,
} from '../../../../packages/shared/src/security/token-config.js';

export const customerAuthConfig = registerAs('customerAuth', () => ({
  ...tokenIdentitySettings(),
  publicKey: tokenPemSetting('AUTH_TOKEN_PUBLIC_KEY'),
}));
export type CustomerAuthSettings = ConfigType<typeof customerAuthConfig>;
