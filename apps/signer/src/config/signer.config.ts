import { registerAs } from '@nestjs/config';
import {
  chainNetworkOverridesFromEnv,
  chainNetworksFromEnv,
} from '../../../../packages/chain/src/config.js';
import { Chain, chainFamily } from '../../../../packages/shared/src/contracts.js';
import { required } from '../../../../packages/shared/src/config.js';

export const signerConfig = registerAs('signer', () => {
  const ethereumChainId = required('ETH_CHAIN_ID');
  const chainIds = {
    ethereum: ethereumChainId,
    ...Object.fromEntries(
      Object.entries(chainNetworkOverridesFromEnv())
        .filter(([chain]) => chainFamily(chain as Chain) === 'ethereum')
        .map(([chain, settings]) => [chain, settings.chainId]),
    ),
  } as Record<string, string>;
  return {
    seedFile: required('SIGNER_SEED_FILE'),
    seedId: required('SIGNER_SEED_ID'),
    ethereumChainId,
    ethereumChainIds: chainIds,
    domainId: required('EXCHANGE_DOMAIN_ID'),
    chainNetworks: Object.fromEntries(
      Object.entries(chainNetworksFromEnv(ethereumChainId, required('SOLANA_GENESIS_HASH'))).map(
        ([chain, settings]) => [
          chain,
          {
            network: settings.network,
            ...(settings.chainId ? { chainId: settings.chainId } : {}),
            ...(settings.genesisHash ? { genesisHash: settings.genesisHash } : {}),
          },
        ],
      ),
    ),
  };
});
