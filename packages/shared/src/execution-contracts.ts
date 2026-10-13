import { z } from 'zod';
import {
  tokenPreparationSchema,
  tokenExecutionAssetSchema,
  tokenCostsSchema,
} from './token-contracts.js';
import { tokenExecutionAuthorizationSchema } from './token-authorization.js';
import { signSchema, signedSchema } from './contracts.js';
import {
  executionUnitsSchema,
  nativeExecutionAssetSchema,
  signedExecutionAuthorizationSchema,
  signerAttestationSchema,
} from './execution-authorization.js';

export const executionAssetSchema = z.union([
  nativeExecutionAssetSchema,
  tokenExecutionAssetSchema,
]);

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
const fundingPlanData = z
  .object({
    sourceWalletId: z.uuid(),
    destinationWalletId: z.uuid(),
    asset: nativeExecutionAssetSchema,
    sourceRegistryRevision: z.number().int().positive(),
    hotRegistryRevision: z.number().int().positive(),
    generation: z.number().int().positive(),
    amount: executionUnitsSchema.refine((v) => BigInt(v) > 0n),
    feeReservationId: z.uuid(),
    fundedAssetId: z.string().regex(/^token:ethereum:erc20:0x[0-9a-f]{40}$/),
    certificateDigest: digest,
  })
  .strict();
const fundingEvents = [
  base.extend({ type: z.literal('funding.plan.requested.v1'), data: fundingPlanData }).strict(),
  base
    .extend({
      type: z.literal('funding.plan.prepared.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          amount: z
            .object({
              asset: nativeExecutionAssetSchema,
              amount: executionUnitsSchema.refine((v) => BigInt(v) > 0n),
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
      type: z.literal('funding.plan.deferred.v1'),
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
export const executionEventSchemas = [
  ...fundingEvents,
  base
    .extend({
      type: z.literal('sweep.plan.requested.v1'),
      data: z
        .object({
          sourceWalletId: z.uuid(),
          destinationWalletId: z.uuid(),
          asset: executionAssetSchema,
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
              asset: executionAssetSchema,
              amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
            })
            .strict(),
          preparationDigest: digest,
          maxFeeUnits: executionUnitsSchema,
          tokenCosts: tokenCostsSchema.optional(),
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
          asset: executionAssetSchema,
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
              asset: executionAssetSchema,
              amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
            })
            .strict(),
          preparationDigest: digest,
          maxFeeUnits: executionUnitsSchema,
          tokenCosts: tokenCostsSchema.optional(),
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

// Separate private action: enabling the native signer does not admit token transactions.
export const tokenCustodySignSchema = z
  .object({
    type: z.literal('transaction.token.sign'),
    ...binding,
    prepared: tokenPreparationSchema,
    authorization: tokenExecutionAuthorizationSchema,
  })
  .strict()
  .superRefine((r, ctx) => {
    const c = r.authorization.claims;
    if (
      r.operationId !== c.operationId ||
      r.attemptId !== c.attemptId ||
      r.requestDigest !== c.requestDigest ||
      r.preparationDigest !== c.preparationDigest ||
      r.preparationDigest !== r.prepared.preparedDigest
    )
      ctx.addIssue({ code: 'custom', message: 'Token command authorization binding mismatch' });
  });
