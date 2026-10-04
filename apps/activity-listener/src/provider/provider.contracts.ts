import { z } from 'zod';
import { chainSchema } from '../../../../packages/shared/src/contracts.js';

// This is the exchange provider gateway protocol, not the upstream QuickNode Streams API.
// The gateway must durably ingest historical deliveries before certifying complete coverage.
export const providerNameSchema = z.enum(['quicknode', 'bitcoin-core']);
export const providerCertificationSchema = z
  .object({
    provider: providerNameSchema,
    chain: chainSchema,
    network: z.string().min(1).max(128),
    assetScope: z.literal('native'),
    watchInstall: z.literal(true),
    watchRemove: z.literal(true),
    backfill: z.literal(true),
    stableTransferIdentity: z.literal(true),
    rawUnits: z.literal(true),
    resetEpochDelivery: z.literal(true),
    nativeTraceCoverage: z.literal(true).optional(),
  })
  .strict()
  .superRefine((certificate, ctx) => {
    if (certificate.chain === 'ethereum' && !certificate.nativeTraceCoverage)
      ctx.addIssue({
        code: 'custom',
        message: 'Ethereum native custody requires certified trace discovery',
      });
  });
export type ProviderCertification = z.infer<typeof providerCertificationSchema>;

export const providerWatchIdentitySchema = z
  .object({
    protocolVersion: z.literal(1),
    provider: providerNameSchema,
    domainId: z.string().min(1).max(128),
    resetEpoch: z.string().min(1).max(128),
    walletId: z.uuid(),
    registryRevision: z.number().int().positive(),
    generation: z.uuid(),
    chain: chainSchema,
    network: z.string().min(1).max(128),
    address: z.string().min(1).max(256),
    assetScope: z.literal('native'),
  })
  .strict();
export type ProviderWatchIdentity = z.infer<typeof providerWatchIdentitySchema>;
export type ProviderInstallRequest = ProviderWatchIdentity & { fromCursor?: string };
export const providerInstallAcknowledgmentSchema = providerWatchIdentitySchema
  .extend({
    status: z.literal('installed'),
    watchId: z.string().min(1).max(256),
    startCursor: z.string().min(1).max(256),
  })
  .strict();
export type ProviderInstallAcknowledgment = z.infer<typeof providerInstallAcknowledgmentSchema>;

export type ProviderBackfillRequest = ProviderWatchIdentity & {
  watchId: string;
  fromCursor: string;
  throughCursor: string;
};
export const providerBackfillPageSchema = providerWatchIdentitySchema
  .extend({
    watchId: z.string().min(1).max(256),
    fromCursor: z.string().min(1).max(256),
    throughCursor: z.string().min(1).max(256),
    cursor: z.string().min(1).max(256),
    complete: z.boolean(),
    transactionHashes: z.array(z.string().min(1).max(256)).max(500),
  })
  .strict();
export type ProviderBackfillPage = z.infer<typeof providerBackfillPageSchema>;
export type ProviderRemoveRequest = ProviderWatchIdentity & { watchId: string };
export const providerRemoveAcknowledgmentSchema = providerWatchIdentitySchema
  .extend({
    watchId: z.string().min(1).max(256),
    status: z.literal('removed'),
  })
  .strict();
export type ProviderRemoveAcknowledgment = z.infer<typeof providerRemoveAcknowledgmentSchema>;

export interface ExchangeWatchProvider {
  readonly name: z.infer<typeof providerNameSchema>;
  providerFor?(chain: string, network: string): z.infer<typeof providerNameSchema> | undefined;
  certified(chain: string, network: string): boolean;
  install(request: ProviderInstallRequest): Promise<ProviderInstallAcknowledgment>;
  backfill(request: ProviderBackfillRequest): Promise<ProviderBackfillPage>;
  remove(request: ProviderRemoveRequest): Promise<ProviderRemoveAcknowledgment>;
}
export const EXCHANGE_WATCH_PROVIDER = Symbol('EXCHANGE_WATCH_PROVIDER');
