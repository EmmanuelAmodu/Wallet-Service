import { z } from 'zod';
import { chainSchema, isEvmChain } from '../../shared/src/contracts.js';

const resetEpoch = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const positiveAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((value) => BigInt(value) < 1n << 256n, 'Amount exceeds uint256');
const base58Character = '[1-9A-HJ-NP-Za-km-z]';
const assetIdPattern = new RegExp(
  [
    '^token:[a-zA-Z0-9]+:',
    '(?:native|erc20:0x[0-9a-fA-F]{40}|',
    `spl:${base58Character}{32,44}:${base58Character}{32,44}`,
    ')$',
  ].join(''),
);
const assetId = z.string().regex(assetIdPattern);
export const canonicalAssetSchema = z
  .object({
    chain: chainSchema,
    network: z.string().min(1).max(128),
    assetId,
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (!asset.assetId.startsWith(`token:${asset.chain}:`))
      ctx.addIssue({ code: 'custom', message: 'Asset ID chain does not match canonical chain' });
    if (asset.assetId.includes(':erc20:')) {
      const contract = asset.assetId.slice(asset.assetId.lastIndexOf(':') + 1);
      if (!isEvmChain(asset.chain) || contract !== contract.toLowerCase())
        ctx.addIssue({
          code: 'custom',
          message: 'ERC-20 identity requires an EVM chain and lowercase contract',
        });
    }
    if (asset.assetId.includes(':spl:') && asset.chain !== 'solana')
      ctx.addIssue({ code: 'custom', message: 'SPL identity requires Solana' });
  });
export type CanonicalAsset = z.infer<typeof canonicalAssetSchema>;
export const assetAmountSchema = z
  .object({ asset: canonicalAssetSchema, amount: positiveAmountSchema })
  .strict();
export type AssetAmount = z.infer<typeof assetAmountSchema>;
const transferIdentitySchema = z
  .object({
    kind: z.enum(['bitcoin.vout', 'evm.log', 'evm.trace', 'evm.native', 'solana.instruction']),
    id: z.string().min(1).max(256),
  })
  .strict();

const eventBaseSchema = z.object({
  eventId: z.uuid(),
  schemaVersion: z.literal(1),
  resetEpoch,
  occurredAt: z.iso.datetime({ offset: true }),
  domainId: z.string().min(1).max(128),
  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  aggregateId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  customerId: z.uuid().optional(),
  operationId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
  requestDigest: digest.optional(),
  policyVersion: z.string().min(1).max(64).optional(),
});

function event<
  TType extends string,
  TData extends z.ZodType,
  TRequired extends z.ZodRawShape = Record<never, never>,
>(type: TType, data: TData, required: TRequired = {} as TRequired) {
  return eventBaseSchema
    .extend(required)
    .extend({ type: z.literal(type), data })
    .strict();
}

const registryRequested = event(
  'customer-wallet.registry.requested.v1',
  z
    .object({
      walletId: z.uuid(),
      chain: chainSchema,
      network: z.string().min(1).max(128),
      address: z.string().min(1).max(256),
      hotWalletId: z.uuid(),
      account: z.number().int().min(10).max(2147483647),
      registryRevision: z.number().int().positive(),
      startCursor: z.string().min(1).max(256).optional(),
    })
    .strict(),
  { customerId: z.uuid() },
);

const custodyRegistryRequested = event(
  'custody-wallet.registry.requested.v1',
  z
    .object({
      walletId: z.uuid(),
      chain: chainSchema,
      network: z.string().min(1).max(128),
      address: z.string().min(1).max(256),
      role: z.enum(['hot', 'management']),
      account: z.number().int().min(0).max(9),
      registryRevision: z.number().int().positive(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (
        (data.role === 'hot' && data.account !== 0) ||
        (data.role === 'management' && data.account < 1)
      )
        ctx.addIssue({ code: 'custom', message: 'Custody role does not match reserved account' });
    }),
);

const registryAcknowledged = event(
  'customer-wallet.registry.acknowledged.v1',
  z
    .object({
      walletId: z.uuid(),
      consumer: z.enum(['activity-listener', 'ledger']),
      registryRevision: z.number().int().positive(),
      status: z.enum(['ready', 'rejected']),
      startCursor: z.string().min(1).max(256).optional(),
      backfillCursor: z.string().min(1).max(256).optional(),
      coverageComplete: z.boolean().optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (
        data.consumer === 'activity-listener' &&
        data.status === 'ready' &&
        (!data.coverageComplete || !data.backfillCursor)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Listener readiness requires verified backfill coverage',
        });
    }),
);

const depositObserved = event(
  'deposit.observed.v1',
  z
    .object({
      depositId: z.uuid(),
      walletId: z.uuid(),
      asset: canonicalAssetSchema,
      transferIdentity: transferIdentitySchema,
      transactionHash: z.string().min(1).max(256),
      amount: positiveAmountSchema,
    })
    .strict(),
  { customerId: z.uuid() },
);

const depositFinalized = event(
  'deposit.finalized.v1',
  z
    .object({
      depositId: z.uuid(),
      walletId: z.uuid(),
      asset: canonicalAssetSchema,
      transferIdentity: transferIdentitySchema,
      transactionHash: z.string().min(1).max(256),
      amount: positiveAmountSchema,
      blockHash: z.string().min(1).max(256),
      blockHeight: z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .optional(),
    })
    .strict(),
  { customerId: z.uuid() },
);

const depositReverted = event(
  'deposit.reverted.v1',
  z
    .object({
      depositId: z.uuid(),
      asset: canonicalAssetSchema,
      transferIdentity: transferIdentitySchema,
      transactionHash: z.string().min(1).max(256),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  { customerId: z.uuid() },
);

const depositCredited = event(
  'deposit.credited.v1',
  z
    .object({
      depositId: z.uuid(),
      ledgerBatchId: z.uuid(),
      walletId: z.uuid(),
      asset: canonicalAssetSchema,
      amount: positiveAmountSchema,
    })
    .strict(),
  { customerId: z.uuid() },
);

const depositReversed = event(
  'deposit.reversed.v1',
  z
    .object({
      depositId: z.uuid(),
      ledgerBatchId: z.uuid(),
      asset: canonicalAssetSchema,
      amount: positiveAmountSchema,
      reason: z.string().min(1).max(500),
      deficitIncidentId: z.uuid().optional(),
    })
    .strict(),
  { customerId: z.uuid() },
);

const depositDeficitRecorded = event(
  'deposit.deficit-recorded.v1',
  z
    .object({
      depositId: z.uuid(),
      incidentId: z.uuid(),
      asset: canonicalAssetSchema,
      amount: positiveAmountSchema,
      reason: z.string().min(1).max(500),
    })
    .strict(),
  { customerId: z.uuid() },
);

const withdrawalReserveRequested = event(
  'withdrawal.reserve.requested.v1',
  z
    .object({
      amounts: z.array(assetAmountSchema).min(1).max(3),
      principal: assetAmountSchema,
      customerFee: assetAmountSchema.optional(),
      hotWalletId: z.uuid(),
      destination: z.string().min(1).max(256),
      quoteExpiresAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .superRefine((data, ctx) => {
      const key = (asset: CanonicalAsset) =>
        JSON.stringify([asset.chain, asset.network, asset.assetId]);
      const expected = new Map<string, bigint>();
      for (const value of [data.principal, ...(data.customerFee ? [data.customerFee] : [])]) {
        const identity = key(value.asset);
        expected.set(identity, (expected.get(identity) ?? 0n) + BigInt(value.amount));
      }
      const supplied = new Map<string, bigint>();
      for (const value of data.amounts) {
        const identity = key(value.asset);
        if (supplied.has(identity)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Reservation amounts must be grouped uniquely by asset',
          });
          return;
        }
        supplied.set(identity, BigInt(value.amount));
      }
      if (
        expected.size !== supplied.size ||
        [...expected].some(([asset, amount]) => supplied.get(asset) !== amount)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Reservation amounts must equal principal plus accepted customer fee',
        });
    }),
  {
    customerId: z.uuid(),
    operationId: z.uuid(),
    requestDigest: digest,
    policyVersion: z.string().min(1).max(64),
  },
);

const withdrawalReserved = event(
  'withdrawal.reserved.v1',
  z.object({ reservationId: z.uuid(), ledgerBatchId: z.uuid() }).strict(),
  { customerId: z.uuid(), operationId: z.uuid(), requestDigest: digest },
);

const withdrawalReserveRejected = event(
  'withdrawal.reserve.rejected.v1',
  z.object({ code: z.string().min(1).max(64), reason: z.string().min(1).max(500) }).strict(),
  { customerId: z.uuid(), operationId: z.uuid(), requestDigest: digest },
);

const reservationReleaseRequested = event(
  'reservation.release.requested.v1',
  z.object({ reservationId: z.uuid(), reason: z.string().min(1).max(128) }).strict(),
  { customerId: z.uuid(), operationId: z.uuid(), requestDigest: digest },
);

const reservationReleased = event(
  'reservation.released.v1',
  z.object({ reservationId: z.uuid(), ledgerBatchId: z.uuid() }).strict(),
  { customerId: z.uuid(), operationId: z.uuid(), requestDigest: digest },
);

const reservationReleaseRejected = event(
  'reservation.release.rejected.v1',
  z.object({ reservationId: z.uuid(), reason: z.string().min(1).max(500) }).strict(),
  { customerId: z.uuid(), operationId: z.uuid(), requestDigest: digest },
);

const executionIdentityFields = {
  operationId: z.uuid(),
  attemptId: z.uuid(),
  requestDigest: digest,
};

const sweepExecuteRequested = event(
  'sweep.execute.requested.v1',
  z
    .object({
      sourceWalletId: z.uuid(),
      destinationWalletId: z.uuid(),
      amount: assetAmountSchema,
    })
    .strict(),
  executionIdentityFields,
);

const withdrawalExecuteRequested = event(
  'withdrawal.execute.requested.v1',
  z
    .object({
      sourceWalletId: z.uuid(),
      destination: z.string().min(1).max(256),
      amount: assetAmountSchema,
    })
    .strict(),
  executionIdentityFields,
);

const fundingExecuteRequested = event(
  'funding.execute.requested.v1',
  z
    .object({
      sourceWalletId: z.uuid(),
      destinationWalletId: z.uuid(),
      amount: assetAmountSchema,
    })
    .strict(),
  executionIdentityFields,
);

const settlementRequested = event(
  'settlement.requested.v1',
  z
    .object({
      transactionHash: z.string().min(1).max(256),
      actualFees: z.array(assetAmountSchema).max(3),
      outcome: z.enum(['confirmed', 'failed']),
    })
    .strict(),
  { operationId: z.uuid(), attemptId: z.uuid(), requestDigest: digest },
);

const settlementReverted = event(
  'settlement.reverted.v1',
  z
    .object({
      priorSettlementRevision: z.number().int().positive(),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  { operationId: z.uuid(), attemptId: z.uuid(), requestDigest: digest },
);

const operationReconcileRequested = event(
  'operation.reconcile.requested.v1',
  z.object({ reservationId: z.uuid().optional() }).strict(),
  { operationId: z.uuid(), requestDigest: digest },
);
const operationReconcileResponded = event(
  'operation.reconcile.responded.v1',
  z
    .object({
      found: z.boolean(),
      state: z.string().min(1).max(64).optional(),
      sourceRevision: z.number().int().positive().optional(),
    })
    .strict(),
  { operationId: z.uuid(), requestDigest: digest },
);

const settlementCommitted = event(
  'settlement.committed.v1',
  z.object({ ledgerBatchId: z.uuid(), transactionHash: z.string().min(1).max(256) }).strict(),
  { operationId: z.uuid(), attemptId: z.uuid(), requestDigest: digest },
);
const settlementReversed = event(
  'settlement.reversed.v1',
  z
    .object({
      ledgerBatchId: z.uuid(),
      priorSettlementRevision: z.number().int().positive(),
      reservationId: z.uuid().optional(),
    })
    .strict(),
  { operationId: z.uuid(), attemptId: z.uuid(), requestDigest: digest },
);

const executionAttemptUpdated = event(
  'execution.attempt.updated.v1',
  z
    .object({
      state: z.enum([
        'preparing',
        'signing',
        'signed',
        'queued',
        'submitted',
        'confirmed',
        'failed',
        'attention',
      ]),
      transactionHash: z.string().min(1).max(256).optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  { operationId: z.uuid(), attemptId: z.uuid(), requestDigest: digest },
);

const custodyIncident = <T extends string>(type: T) =>
  event(
    type,
    z
      .object({
        incidentId: z.uuid(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        category: z.string().min(1).max(64),
        status: z.enum(['open', 'acknowledged', 'investigating', 'resolved']),
        reason: z.string().min(1).max(1000),
      })
      .strict(),
  );

const incidentOpened = custodyIncident('custody.incident.opened.v1');
const incidentUpdated = custodyIncident('custody.incident.updated.v1');
const incidentResolved = custodyIncident('custody.incident.resolved.v1');

export const exchangeEventSchema = z.discriminatedUnion('type', [
  registryRequested,
  custodyRegistryRequested,
  registryAcknowledged,
  depositObserved,
  depositFinalized,
  depositReverted,
  depositCredited,
  depositReversed,
  depositDeficitRecorded,
  withdrawalReserveRequested,
  withdrawalReserved,
  withdrawalReserveRejected,
  reservationReleaseRequested,
  reservationReleased,
  reservationReleaseRejected,
  sweepExecuteRequested,
  withdrawalExecuteRequested,
  fundingExecuteRequested,
  settlementRequested,
  settlementReverted,
  settlementCommitted,
  settlementReversed,
  executionAttemptUpdated,
  operationReconcileRequested,
  operationReconcileResponded,
  incidentOpened,
  incidentUpdated,
  incidentResolved,
]);
export type ExchangeEvent = z.infer<typeof exchangeEventSchema>;
