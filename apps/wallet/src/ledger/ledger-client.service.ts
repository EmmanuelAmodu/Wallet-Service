import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { LedgerWalletRegistration } from '../../../../packages/shared/src/activity-contracts.js';
import { walletConfig } from '../config/wallet.config.js';
import { canonicalAssetSchema } from '../../../../packages/queue/src/exchange-contracts.js';

const unsignedBalance = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((amount) => BigInt(amount) < 1n << 256n);
const exchangeBalancesSchema = z
  .object({
    customerId: z.uuid(),
    domainId: z.string().min(1).max(128),
    state: z.enum(['active', 'frozen']),
    balances: z.array(
      canonicalAssetSchema
        .extend({
          available: unsignedBalance,
          reserved: unsignedBalance,
          frozen: unsignedBalance,
          pending: unsignedBalance,
        })
        .strict(),
    ),
  })
  .strict();

const balancesSchema = z
  .object({
    walletId: z.uuid(),
    chain: z.string(),
    network: z.string(),
    balances: z.array(
      z.object({
        asset: z.string(),
        confirmed: z.string(),
        provisional: z.string(),
      }),
    ),
  })
  .strict();

@Injectable()
export class LedgerClient {
  constructor(@Inject(walletConfig.KEY) private readonly wallet: ConfigType<typeof walletConfig>) {}

  async exchangeBalances(domainId: string, customerId: string) {
    try {
      const url = new URL(
        `/internal/exchange/customers/${customerId}/balances`,
        this.wallet.ledgerUrl.replace(/\/$/, ''),
      );
      url.searchParams.set('domainId', domainId);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.wallet.ledgerApiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Ledger customer balance query failed');
      const balances = exchangeBalancesSchema.parse(await response.json());
      if (balances.customerId !== customerId || balances.domainId !== domainId)
        throw new Error('Ledger customer balance identity mismatch');
      const identities = balances.balances.map(({ chain, network, assetId }) =>
        JSON.stringify([chain, network, assetId]),
      );
      if (new Set(identities).size !== identities.length)
        throw new Error('Duplicate Ledger asset identity');
      return balances;
    } catch {
      throw new BadGatewayException('Ledger service is unavailable');
    }
  }

  async balances(registration: LedgerWalletRegistration) {
    const baseUrl = this.wallet.ledgerUrl.replace(/\/$/, '');
    const authorization = `Bearer ${this.wallet.ledgerApiKey}`;
    try {
      const registered = await fetch(`${baseUrl}/internal/wallets`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(registration),
        signal: AbortSignal.timeout(10000),
      });
      if (!registered.ok) throw new Error('Ledger wallet registration failed');
      const url = new URL(`/internal/wallets/${registration.walletId}/balances`, baseUrl);
      url.searchParams.set('tenantId', registration.tenantId);
      const response = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Ledger balance query failed');
      return balancesSchema.parse(await response.json());
    } catch {
      throw new BadGatewayException('Ledger service is unavailable');
    }
  }
}
