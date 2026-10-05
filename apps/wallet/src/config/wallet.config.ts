import { registerAs, ConfigType } from '@nestjs/config';
import { chainNetworksFromEnv } from '../../../../packages/chain/src/config.js';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';
import { token } from '../../../../packages/shared/src/security/tokens.js';

export const walletConfig = registerAs('wallet', () => {
  const ethereumChainId = required('ETH_CHAIN_ID');
  const solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  const apiKey = token(required('WALLET_API_KEY'));
  const queueAuthKey = required('QUEUE_AUTH_KEY');
  const ledgerApiKey = token(
    process.env.LEDGER_API_KEY ??
      (process.env.NODE_ENV === 'production' ? required('LEDGER_API_KEY') : queueAuthKey),
  );
  if ([queueAuthKey, ledgerApiKey].includes(apiKey))
    throw new Error('Use distinct wallet backend, Ledger, and queue credentials');
  if (process.env.NODE_ENV === 'production' && ledgerApiKey === queueAuthKey)
    throw new Error('Use a distinct ledger API key in production');
  return {
    databaseUrl: required('WALLET_DATABASE_URL'),
    seedId: required('SIGNER_SEED_ID'),
    ethereumChainId,
    solanaGenesisHash,
    chainNetworks: chainNetworksFromEnv(ethereumChainId, solanaGenesisHash),
    ledgerUrl:
      process.env.LEDGER_URL ??
      (process.env.NODE_ENV === 'production' ? required('LEDGER_URL') : 'http://127.0.0.1:3010'),
    ledgerApiKey,
    host: process.env.WALLET_HOST ?? '127.0.0.1',
    port: integerSetting('WALLET_PORT', 3000, 1, 65535),
    apiKey,
  };
});
export type WalletSettings = ConfigType<typeof walletConfig>;
export type WalletConfig = Pick<
  WalletSettings,
  'seedId' | 'ethereumChainId' | 'solanaGenesisHash'
> &
  Partial<Pick<WalletSettings, 'chainNetworks'>>;
