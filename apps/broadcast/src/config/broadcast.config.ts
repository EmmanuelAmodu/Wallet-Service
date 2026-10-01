import { registerAs, ConfigType } from '@nestjs/config';
import { integerSetting, required } from '../../../../packages/shared/src/config';

export const broadcastConfig = registerAs('broadcast', () => {
  const allow = process.env.ALLOW_BROADCAST ?? 'false';
  if (!['true', 'false'].includes(allow)) throw new Error('Invalid configuration: ALLOW_BROADCAST');
  return {
    databaseUrl: required('BROADCAST_DATABASE_URL'),
    allowBroadcast: allow === 'true',
    ethereumChainId: required('ETH_CHAIN_ID'),
    solanaGenesisHash: required('SOLANA_GENESIS_HASH'),
    pollIntervalMs: integerSetting('CONFIRMATION_POLL_MS', 30000, 10, 86400000),
    maxPolls: integerSetting('CONFIRMATION_MAX_POLLS', 120, 1, 10000),
  };
});
export type BroadcastConfig = Omit<ConfigType<typeof broadcastConfig>, 'databaseUrl'>;
