import { required } from '../../shared/src/http';
import { Chain } from '../../shared/src/contracts';
export function networkConfig() {
  return {
    ethereumChainId: required('ETH_CHAIN_ID'),
    solanaGenesisHash: required('SOLANA_GENESIS_HASH'),
    ethereumUrl: process.env.ETH_RPC_URL,
    bitcoinUrl: process.env.BTC_RPC_URL,
    bitcoinUser: process.env.BTC_RPC_USER,
    bitcoinPassword: process.env.BTC_RPC_PASSWORD,
    solanaUrl: process.env.SOLANA_RPC_URL,
  };
}
export function networkFor(
  chain: Chain,
  config: { ethereumChainId: string; solanaGenesisHash: string },
) {
  return chain === 'ethereum'
    ? config.ethereumChainId
    : chain === 'bitcoin'
      ? 'mainnet'
      : config.solanaGenesisHash;
}
