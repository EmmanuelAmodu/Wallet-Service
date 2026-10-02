import { registerAs, ConfigType } from '@nestjs/config';
import { chainNetworksFromEnv } from '../../../../packages/chain/src/config.js';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export const broadcastConfig = registerAs('broadcast', () => {
  const allow = process.env.ALLOW_BROADCAST ?? 'false';
  if (!['true', 'false'].includes(allow)) throw new Error('Invalid configuration: ALLOW_BROADCAST');
  const ethereumChainId = required('ETH_CHAIN_ID');
  const solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  return {
    databaseUrl: required('BROADCAST_DATABASE_URL'),
    allowBroadcast: allow === 'true',
    ethereumChainId,
    solanaGenesisHash,
    chainNetworks: chainNetworksFromEnv(ethereumChainId, solanaGenesisHash),
    pollIntervalMs: integerSetting('CONFIRMATION_POLL_MS', 30000, 10, 86400000),
    maxPolls: integerSetting('CONFIRMATION_MAX_POLLS', 120, 1, 10000),
  };
});
export type BroadcastConfig = Omit<
  ConfigType<typeof broadcastConfig>,
  'databaseUrl' | 'chainNetworks'
> & { chainNetworks?: ConfigType<typeof broadcastConfig>['chainNetworks'] };
