import { z } from 'zod';
import { signSchema, signedSchema } from './contracts.js';
import {
  executionUnitsSchema,
  nativeExecutionAssetSchema,
  signedExecutionAuthorizationSchema,
  signerAttestationSchema,
} from './execution-authorization.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({
  eventId: z.uuid(),
  schemaVersion: z.literal(1),
  resetEpoch: z.string().min(1).max(128),
  occurredAt: z.iso.datetime({ offset: true }),
  domainId: z.string().min(1).max(128),
  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  aggregateId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  customerId: z.uuid(),
  operationId: z.uuid(),
  attemptId: z.uuid(),
  requestDigest: digest,
  policyVersion: z.string().min(1).max(64),
});
export const executionEventSchemas = [
  base
    .extend({
      type: z.literal('sweep.plan.requested.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          asset: nativeExecutionAssetSchema,
          sourceRegistryRevision: z.number().int().positive(),
          hotRegistryRevision: z.number().int().positive(),
          generation: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      type: z.literal('sweep.plan.prepared.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          amount: z
            .object({
              asset: nativeExecutionAssetSchema,
              amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
            })
            .strict(),
          preparationDigest: digest,
          maxFeeUnits: executionUnitsSchema,
          expiresAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      type: z.literal('sweep.plan.deferred.v1'),
      data: z
        .object({
          code: z.string().min(1).max(128),
          reason: z.string().min(1).max(500),
          retryAfter: z.iso.datetime({ offset: true }),
          preparationDigest: digest.optional(),
          terminalSafe: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      type: z.literal('withdrawal.plan.requested.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          asset: nativeExecutionAssetSchema,
          sourceRegistryRevision: z.number().int().positive(),
          hotRegistryRevision: z.number().int().positive(),
          generation: z.number().int().nonnegative(),
          destination: z.string().min(1).max(256),
          amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
          reservationId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      type: z.literal('withdrawal.plan.prepared.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          amount: z
            .object({
              asset: nativeExecutionAssetSchema,
              amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
            })
            .strict(),
          preparationDigest: digest,
          maxFeeUnits: executionUnitsSchema,
          expiresAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      type: z.literal('withdrawal.plan.deferred.v1'),
      data: z
        .object({
          code: z.string().min(1).max(128),
          reason: z.string().min(1).max(500),
          retryAfter: z.iso.datetime({ offset: true }),
          preparationDigest: digest.optional(),
          terminalSafe: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
] as const;
const binding = {
  transactionId: z.uuid(),
  operationId: z.uuid(),
  attemptId: z.uuid(),
  requestDigest: digest,
  preparationDigest: digest,
};
export const custodySignSchema = z
  .object({
    type: z.literal('transaction.custody.sign'),
    ...binding,
    request: signSchema,
    authorization: signedExecutionAuthorizationSchema,
  })
  .strict();
export const custodySignedSchema = z
  .object({
    type: z.literal('transaction.custody.signed'),
    ...binding,
    signed: signedSchema,
    signerAttestation: signerAttestationSchema,
  })
  .strict();
export const custodyRejectedSchema = z
  .object({
    type: z.literal('transaction.custody.rejected'),
    ...binding,
    reason: z.string().min(1).max(500),
    signerAttestation: signerAttestationSchema,
  })
  .strict();
export type CustodySignAction = z.infer<typeof custodySignSchema>;
export type CustodySignedAction = z.infer<typeof custodySignedSchema>;
export type CustodyRejectedAction = z.infer<typeof custodyRejectedSchema>;
