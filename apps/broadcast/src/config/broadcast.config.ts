import { registerAs, ConfigType } from '@nestjs/config';
import { chainNetworksFromEnv } from '../../../../packages/chain/src/config.js';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

function signerPublicKey() {
  const encoded = readFileSync(required('EXECUTION_SIGNER_PUBLIC_KEY_FILE'));
  if (!encoded.toString('utf8').trimStart().startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Execution signer key must be public-only PEM');
  const key = createPublicKey(encoded);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Execution signer key must be Ed25519');
  return key;
}

export const broadcastConfig = registerAs('broadcast', () => {
  const allow = process.env.ALLOW_BROADCAST ?? 'false';
  if (!['true', 'false'].includes(allow)) throw new Error('Invalid configuration: ALLOW_BROADCAST');
  const ethereumChainId = required('ETH_CHAIN_ID');
  const solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  const native = process.env.ENABLE_NATIVE_SWEEPS ?? 'false';
  if (native !== 'true' && native !== 'false')
    throw new Error('Invalid configuration: ENABLE_NATIVE_SWEEPS');
  const withdrawals = process.env.ENABLE_NATIVE_WITHDRAWALS ?? 'false';
  if (!['true', 'false'].includes(withdrawals))
    throw new Error('Invalid configuration: ENABLE_NATIVE_WITHDRAWALS');
  const tokens = process.env.ENABLE_TOKEN_EXECUTION ?? 'false';
  if (!['true', 'false'].includes(tokens))
    throw new Error('Invalid configuration: ENABLE_TOKEN_EXECUTION');
  const custodyMode = process.env.EXCHANGE_DOMAIN_ID !== undefined;
  const batches = process.env.ENABLE_BITCOIN_BATCH_WITHDRAWALS ?? 'false';
  if (!['true', 'false'].includes(batches))
    throw new Error('Invalid configuration: ENABLE_BITCOIN_BATCH_WITHDRAWALS');
  if (batches === 'true' && withdrawals !== 'true')
    throw new Error('Bitcoin batches require native withdrawals');
  const domainId =
    custodyMode || native === 'true' || withdrawals === 'true' || tokens === 'true'
      ? required('EXCHANGE_DOMAIN_ID')
      : undefined;
  return {
    databaseUrl: required('BROADCAST_DATABASE_URL'),
    allowBroadcast: allow === 'true',
    ethereumChainId,
    solanaGenesisHash,
    chainNetworks: chainNetworksFromEnv(ethereumChainId, solanaGenesisHash),
    pollIntervalMs: integerSetting('CONFIRMATION_POLL_MS', 30000, 10, 86400000),
    maxPolls: integerSetting('CONFIRMATION_MAX_POLLS', 120, 1, 10000),
    nativeWithdrawalsEnabled: withdrawals === 'true',
    bitcoinBatchesEnabled: batches === 'true',
    tokenExecutionEnabled: tokens === 'true',
    nativeSweepsEnabled: native === 'true',
    custodyMode,
    ...(domainId ? { domainId } : {}),
    ...(native === 'true' || withdrawals === 'true' || tokens === 'true'
      ? {
          executionSignerPublicKey: signerPublicKey(),
          resetEpoch: required('RESET_EPOCH'),
        }
      : {}),
  };
});
export type BroadcastConfig = Omit<
  ConfigType<typeof broadcastConfig>,
  | 'databaseUrl'
  | 'chainNetworks'
  | 'nativeSweepsEnabled'
  | 'nativeWithdrawalsEnabled'
  | 'custodyMode'
  | 'tokenExecutionEnabled'
  | 'bitcoinBatchesEnabled'
> & {
  chainNetworks?: ConfigType<typeof broadcastConfig>['chainNetworks'];
  nativeSweepsEnabled?: boolean;
  nativeWithdrawalsEnabled?: boolean;
  custodyMode?: boolean;
  tokenExecutionEnabled?: boolean;
  bitcoinBatchesEnabled?: boolean;
};
