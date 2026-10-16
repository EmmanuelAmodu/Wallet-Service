import { registerAs } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { required } from '../../shared/src/config.js';
import { Chain, chainFamily, chainSchema } from '../../shared/src/contracts.js';

export const chainNetworkSchema = z
  .object({
    network: z.string().min(1),
    rpcUrl: z.string().url().optional(),
    chainId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    genesisHash: z.string().min(1).optional(),
    rpcUser: z.string().optional(),
    rpcPassword: z.string().optional(),
    rpcNetwork: z.string().min(1).optional(),
    confirmations: z.number().int().min(1).max(100000).optional(),
  })
  .strict();
export type ChainNetworkSettings = z.infer<typeof chainNetworkSchema>;
export type ChainNetworkMap = Record<string, ChainNetworkSettings>;

export function chainNetworkOverridesFromEnv(): ChainNetworkMap {
  let input: unknown;
  try {
    input = JSON.parse(process.env.CHAIN_NETWORKS ?? '{}');
  } catch {
    throw new Error('Invalid configuration: CHAIN_NETWORKS must be valid JSON');
  }
  const networks = z.record(z.string(), chainNetworkSchema).parse(input);
  for (const [name, settings] of Object.entries(networks)) {
    const chain = chainSchema.safeParse(name);
    if (!chain.success) throw new Error(`Unsupported CHAIN_NETWORKS chain: ${name}`);
    const family = chainFamily(chain.data);
    if (family === 'ethereum' && !settings.chainId)
      throw new Error(`CHAIN_NETWORKS.${name}.chainId is required for EVM chains`);
    if (family === 'ethereum' && settings.network !== settings.chainId)
      throw new Error(`CHAIN_NETWORKS.${name}.network must equal its EVM chainId`);
    if (family === 'bitcoin') {
      if (
        settings.network !== 'mainnet' &&
        !(name === 'bitcoin' && ['regtest', 'testnet'].includes(settings.network))
      )
        throw new Error(
          `CHAIN_NETWORKS.${name}.network must be mainnet, Bitcoin regtest or Bitcoin testnet`,
        );
      const expected =
        settings.network === 'regtest'
          ? 'regtest'
          : settings.network === 'testnet'
            ? 'test'
            : 'main';
      if (settings.rpcNetwork && settings.rpcNetwork !== expected)
        throw new Error(`CHAIN_NETWORKS.${name}.rpcNetwork does not match its network`);
      settings.rpcNetwork = expected;
    }
    if (family === 'solana' && !settings.genesisHash)
      throw new Error(`CHAIN_NETWORKS.${name}.genesisHash is required for Solana`);
  }
  return networks;
}

export function chainNetworksFromEnv(
  ethereumChainId: string,
  solanaGenesisHash: string,
): ChainNetworkMap {
  const defaults: ChainNetworkMap = {
    ethereum: {
      network: ethereumChainId,
      chainId: ethereumChainId,
      rpcUrl: process.env.ETH_RPC_URL || undefined,
    },
    bitcoin: {
      network: 'mainnet',
      rpcNetwork: 'main',
      rpcUrl: process.env.BTC_RPC_URL || undefined,
      rpcUser: process.env.BTC_RPC_USER,
      rpcPassword: process.env.BTC_RPC_PASSWORD,
      confirmations: 6,
    },
    solana: {
      network: solanaGenesisHash,
      genesisHash: solanaGenesisHash,
      rpcUrl: process.env.SOLANA_RPC_URL || undefined,
    },
  };
  const overrides = chainNetworkOverridesFromEnv();
  for (const [chain, settings] of Object.entries(overrides))
    if (!defaults[chain] && !settings.rpcUrl)
      throw new Error(`CHAIN_NETWORKS.${chain}.rpcUrl is required`);
  return Object.fromEntries(
    [...new Set([...Object.keys(defaults), ...Object.keys(overrides)])].map((chain) => [
      chain,
      { ...defaults[chain], ...overrides[chain] },
    ]),
  );
}

export const networkConfig = registerAs('network', () => {
  const ethereumChainId = required('ETH_CHAIN_ID');
  const solanaGenesisHash = required('SOLANA_GENESIS_HASH');
  return {
    ethereumChainId,
    solanaGenesisHash,
    ethereumUrl: process.env.ETH_RPC_URL,
    bitcoinUrl: process.env.BTC_RPC_URL,
    bitcoinUser: process.env.BTC_RPC_USER,
    bitcoinPassword: process.env.BTC_RPC_PASSWORD,
    solanaUrl: process.env.SOLANA_RPC_URL,
    chainNetworks: chainNetworksFromEnv(ethereumChainId, solanaGenesisHash),
  };
});

export function networkFor(
  chain: Chain,
  config: {
    ethereumChainId: string;
    solanaGenesisHash: string;
    chainNetworks?: ChainNetworkMap;
  },
) {
  const configured = config.chainNetworks?.[chain];
  if (configured) return configured.network;
  if (chain === 'ethereum') return config.ethereumChainId;
  if (chain === 'bitcoin') return 'mainnet';
  if (chain === 'solana') return config.solanaGenesisHash;
  throw new BadRequestException(`${chain} network is not configured`);
}
