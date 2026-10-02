import { registerAs, ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { chainNetworksFromEnv } from '../../../../packages/chain/src/config.js';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export const walletConfig = registerAs('wallet', () => {
  const ethereumChainId = required('ETH_CHAIN_ID');
  const solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  const apiKeys = z
    .record(z.string().min(1), z.string().min(32))
    .parse(JSON.parse(required('WALLET_API_KEYS')));
  const keys = Object.values(apiKeys);
  if (!keys.length || new Set(keys).size !== keys.length)
    throw new Error('Provide unique API keys');
  if (keys.includes(required('QUEUE_AUTH_KEY')))
    throw new Error('Use distinct tenant and queue credentials');
  return {
    databaseUrl: required('WALLET_DATABASE_URL'),
    seedId: required('SIGNER_SEED_ID'),
    ethereumChainId,
    solanaGenesisHash,
    chainNetworks: chainNetworksFromEnv(ethereumChainId, solanaGenesisHash),
    host: process.env.WALLET_HOST ?? '127.0.0.1',
    port: integerSetting('WALLET_PORT', 3000, 1, 65535),
    apiKeys,
  };
});
export type WalletSettings = ConfigType<typeof walletConfig>;
export type WalletConfig = Pick<
  WalletSettings,
  'seedId' | 'ethereumChainId' | 'solanaGenesisHash'
> &
  Partial<Pick<WalletSettings, 'chainNetworks'>>;
