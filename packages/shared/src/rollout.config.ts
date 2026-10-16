import { registerAs } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export type RolloutAction = 'addresses' | 'credits' | 'sweeps' | 'withdrawals';
export interface RolloutSettings {
  mode: 'closed' | 'dry-run' | 'canary' | 'full';
  addresses: boolean;
  credits: boolean;
  sweeps: boolean;
  withdrawals: boolean;
  canary?: { domainId: string; chain: string; network: string };
}
export const closedRollout: RolloutSettings = {
  mode: 'closed',
  addresses: false,
  credits: false,
  sweeps: false,
  withdrawals: false,
};
export const rolloutConfig = registerAs('exchangeRollout', (): RolloutSettings => {
  const mode = z
    .enum(['closed', 'dry-run', 'canary', 'full'])
    .parse(process.env.EXCHANGE_ROLLOUT_MODE ?? 'closed');
  const flag = (name: string) =>
    z.enum(['true', 'false']).parse(process.env[name] ?? 'false') === 'true';
  const settings: RolloutSettings = {
    mode,
    addresses: flag('ENABLE_ADDRESS_ISSUANCE'),
    credits: flag('ENABLE_DEPOSIT_CREDIT'),
    sweeps: flag('ENABLE_EXCHANGE_SWEEPS'),
    withdrawals: flag('ENABLE_EXCHANGE_WITHDRAWALS'),
  };
  if (mode === 'canary') {
    const chain = z
      .enum(['ethereum', 'bitcoin', 'solana'])
      .parse(process.env.EXCHANGE_CANARY_CHAIN);
    const network = z.string().min(1).parse(process.env.EXCHANGE_CANARY_NETWORK);
    const pinned = {
      ethereum: '11155111',
      bitcoin: network === 'testnet' ? 'testnet' : 'regtest',
      solana: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    };
    if (network !== pinned[chain]) throw new Error('Canary requires a supported pinned network');
    settings.canary = {
      domainId: z.string().min(1).parse(process.env.EXCHANGE_DOMAIN_ID),
      chain,
      network,
    };
  }
  return settings;
});

export function rolloutAllows(
  settings: RolloutSettings,
  action: RolloutAction,
  scope: { domainId: string; chain: string; network: string },
) {
  if (settings.mode === 'closed' || !settings[action]) return false;
  if (settings.mode === 'dry-run' && (action === 'sweeps' || action === 'withdrawals'))
    return false;
  return (
    settings.mode !== 'canary' ||
    (!!settings.canary &&
      settings.canary.domainId === scope.domainId &&
      settings.canary.chain === scope.chain &&
      settings.canary.network === scope.network)
  );
}
export function assertRollout(
  settings: RolloutSettings,
  action: RolloutAction,
  scope: { domainId: string; chain: string; network: string },
) {
  if (!rolloutAllows(settings, action, scope))
    throw new ServiceUnavailableException(`Exchange ${action} paused by rollout policy`);
}
