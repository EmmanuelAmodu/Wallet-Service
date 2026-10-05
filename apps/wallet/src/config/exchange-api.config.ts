import { ConfigType, registerAs } from '@nestjs/config';
import { z } from 'zod';
import { token } from '../../../../packages/shared/src/security/tokens.js';

// Opt-in while the Phase 1 custody bootstrap is unfinished. Missing settings disable the API.
export const exchangeApiConfig = registerAs('exchangeApi', () => {
  const apiKey = process.env.EXCHANGE_API_KEY ? token(process.env.EXCHANGE_API_KEY) : undefined;
  const domainId = process.env.EXCHANGE_DOMAIN_ID
    ? z.string().min(1).max(128).parse(process.env.EXCHANGE_DOMAIN_ID)
    : undefined;
  if (apiKey) {
    if (
      [process.env.QUEUE_AUTH_KEY, process.env.LEDGER_API_KEY, process.env.WALLET_API_KEY].includes(
        apiKey,
      )
    )
      throw new Error('Use a distinct exchange backend API credential');
  }
  return { apiKey, domainId };
});
export type ExchangeApiSettings = ConfigType<typeof exchangeApiConfig>;
