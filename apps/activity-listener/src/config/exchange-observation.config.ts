import { ConfigType, registerAs } from '@nestjs/config';
import { z } from 'zod';
import { chainNetworksFromEnv } from '../../../../packages/chain/src/config.js';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';
export const exchangeObservationConfig = registerAs('exchangeObservation', () => {
  const ethereumChainId = required('ETH_CHAIN_ID'),
    solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  const chainNetworks = chainNetworksFromEnv(ethereumChainId, solanaGenesisHash);
  // Observation-only regtest RPC: this never enables mainnet-only transaction preparation/signing.
  if (process.env.EXCHANGE_BTC_RPC_URL)
    chainNetworks.bitcoin = {
      network: 'regtest',
      rpcNetwork: 'regtest',
      rpcUrl: z.url().parse(process.env.EXCHANGE_BTC_RPC_URL),
      rpcUser: process.env.EXCHANGE_BTC_RPC_USER,
      rpcPassword: process.env.EXCHANGE_BTC_RPC_PASSWORD,
      confirmations: 6,
    };
  const traceMode = z
    .enum(['top-level', 'callTracer'])
    .parse(process.env.EXCHANGE_EVM_TRACE_MODE ?? 'top-level');
  return {
    ethereumChainId,
    solanaGenesisHash,
    chainNetworks,
    traceMode,
    pollMs: integerSetting('EXCHANGE_DEPOSIT_POLL_MS', 30000, 100, 86400000),
    reconciliationMs: integerSetting('EXCHANGE_DEPOSIT_RECONCILIATION_MS', 300000, 100, 86400000),
    recoveryMs: integerSetting('EXCHANGE_RECOVERY_INTERVAL_MS', 10000, 100, 86400000),
  };
});
export type ExchangeObservationSettings = ConfigType<typeof exchangeObservationConfig>;
