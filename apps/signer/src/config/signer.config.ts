import { registerAs } from '@nestjs/config';
import {
  chainNetworkOverridesFromEnv,
  chainNetworksFromEnv,
} from '../../../../packages/chain/src/config.js';
import { Chain, chainFamily } from '../../../../packages/shared/src/contracts.js';
import { required } from '../../../../packages/shared/src/config.js';
import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

function executionKey(name: string, privateKey: boolean): KeyObject {
  const path = required(name),
    stat = statSync(path);
  if (
    !stat.isFile() ||
    (privateKey && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw new Error(`${name} must be a regular ${privateKey ? 'private mode 0600 ' : ''}key file`);
  const encoded = readFileSync(path);
  if (!privateKey && !encoded.toString('utf8').trimStart().startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error(`${name} must contain a public-only PEM key`);
  const key = privateKey ? createPrivateKey(encoded) : createPublicKey(encoded);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${name} must contain an Ed25519 key`);
  return key;
}

export const signerConfig = registerAs('signer', () => {
  const enable = process.env.ENABLE_NATIVE_SWEEPS ?? 'false';
  if (enable !== 'true' && enable !== 'false')
    throw new Error('ENABLE_NATIVE_SWEEPS must be true or false');
  const withdrawals = process.env.ENABLE_NATIVE_WITHDRAWALS ?? 'false';
  if (!['true', 'false'].includes(withdrawals))
    throw new Error('ENABLE_NATIVE_WITHDRAWALS must be true or false');
  const tokens = process.env.ENABLE_TOKEN_SIGNING ?? 'false';
  if (!['true', 'false'].includes(tokens))
    throw new Error('ENABLE_TOKEN_SIGNING must be true or false');
  const tokenSigningEnabled = tokens === 'true';
  const nativeWithdrawalsEnabled = withdrawals === 'true';
  const nativeSweepsEnabled = enable === 'true';
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
    nativeSweepsEnabled,
    tokenSigningEnabled,
    nativeWithdrawalsEnabled,
    ...(nativeSweepsEnabled || nativeWithdrawalsEnabled || tokenSigningEnabled
      ? {
          executionAuthorityPublicKey: executionKey('EXECUTION_AUTHORITY_PUBLIC_KEY_FILE', false),
          executionSignerPrivateKey: executionKey('EXECUTION_SIGNER_PRIVATE_KEY_FILE', true),
        }
      : {}),
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
