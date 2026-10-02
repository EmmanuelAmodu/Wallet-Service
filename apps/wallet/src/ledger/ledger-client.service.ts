import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { LedgerWalletRegistration } from '../../../../packages/shared/src/activity-contracts.js';
import { walletConfig } from '../config/wallet.config.js';

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
