import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { providerCertificationSchema, providerNameSchema } from '../provider/provider.contracts.js';
import type { ExchangeProviderConfig } from '../provider/provider.service.js';

export function exchangeProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ExchangeProviderConfig {
  const name = providerNameSchema.parse(environment.EXCHANGE_PROVIDER_NAME ?? 'quicknode');
  const certifications = z
    .array(providerCertificationSchema)
    .parse(JSON.parse(environment.EXCHANGE_PROVIDER_CERTIFICATIONS ?? '[]'));
  const nativeTraceMode = z
    .enum(['top-level', 'callTracer'])
    .parse(environment.EXCHANGE_EVM_TRACE_MODE ?? 'top-level');
  const bitcoinCertifications = z
    .array(providerCertificationSchema)
    .parse(JSON.parse(environment.EXCHANGE_BITCOIN_PROVIDER_CERTIFICATIONS ?? '[]'));
  return {
    name,
    url: environment.EXCHANGE_PROVIDER_URL,
    apiKey: environment.EXCHANGE_PROVIDER_API_KEY,
    certifications,
    nativeTraceMode,
    bitcoin:
      environment.EXCHANGE_BITCOIN_PROVIDER_URL ||
      environment.EXCHANGE_BITCOIN_PROVIDER_API_KEY ||
      bitcoinCertifications.length
        ? {
            url: environment.EXCHANGE_BITCOIN_PROVIDER_URL,
            apiKey: environment.EXCHANGE_BITCOIN_PROVIDER_API_KEY,
            certifications: bitcoinCertifications,
          }
        : undefined,
  };
}
export const activityProviderConfig = registerAs('activityProvider', () =>
  exchangeProviderConfig(),
);
