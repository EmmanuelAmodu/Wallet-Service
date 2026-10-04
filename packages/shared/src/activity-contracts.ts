import { z } from 'zod';
import { chainSchema } from './contracts.js';

export const walletIdentifierSchema = z.string().regex(/^wallet:[^:]+:.+$/);
export const tokenIdentifierSchema = z.string().regex(/^token:[^:]+:.+$/);
export const ledgerWalletRegistrationSchema = z
  .object({
    walletId: z.uuid(),
    tenantId: z.string().min(1),
    chain: chainSchema,
    network: z.string().min(1),
    address: z.string().min(1),
  })
  .strict();
export type LedgerWalletRegistration = z.infer<typeof ledgerWalletRegistrationSchema>;
export const activityChangeSchema = z
  .object({
    token: tokenIdentifierSchema,
    amount: z.string().min(1).max(128),
  })
  .strict();
export const walletBalanceChangesSchema = z
  .object({
    wallet: walletIdentifierSchema,
    changes: z.array(activityChangeSchema),
  })
  .strict();

export const processorActivitySchema = z
  .object({
    resetEpoch: z.string().min(1).max(128).optional(),
    identifier: z.string().min(1).max(512),
    completedAtTimestamp: z.number().finite().nonnegative(),
    metadata: z.record(z.string(), z.unknown()),
    status: z.enum(['success', 'failed']),
    statusReason: z.string().optional(),
    description: z.string().optional(),
    transfers: z.array(
      z.object({
        from: walletIdentifierSchema,
        to: walletIdentifierSchema,
        amount: z.string().min(1).max(128),
        token: tokenIdentifierSchema,
      }),
    ),
    tokenIdentifiers: z.array(tokenIdentifierSchema),
    tokenTypes: z.record(z.string(), z.enum(['erc20', 'erc721', 'erc1155'])).optional(),
    fee: z.object({ amount: z.number().finite(), feePayer: z.array(walletIdentifierSchema) }),
    balanceChanges: z.array(walletBalanceChangesSchema),
  })
  .passthrough();
export type ProcessorActivity = z.infer<typeof processorActivitySchema>;

export const ledgerActivityStateSchema = z.enum([
  'observed',
  'finalized',
  'failed',
  'reverted',
  'attention',
]);
export const ledgerActivityChangeSchema = z
  .object({
    wallet: walletIdentifierSchema,
    asset: tokenIdentifierSchema,
    amount: z.string().regex(/^(?:0|-?[1-9][0-9]{0,77})$/),
  })
  .strict();
export const ledgerActivitySchema = z
  .object({
    identifier: z.string().min(1).max(512),
    chain: chainSchema,
    network: z.string().min(1).max(128),
    transactionHash: z.string().min(1).max(256),
    sourceStatus: z.enum(['success', 'failed']),
    state: ledgerActivityStateSchema,
    completedAtTimestamp: z.number().finite().nonnegative(),
    observationSequence: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .optional(),
    canonicalReconciliation: z.boolean().optional(),
    blockHash: z.string().min(1).max(256).optional(),
    blockHeight: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .optional(),
    changes: z.array(ledgerActivityChangeSchema),
  })
  .strict();
export type LedgerActivity = z.infer<typeof ledgerActivitySchema>;
