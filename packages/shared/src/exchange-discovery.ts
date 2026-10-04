import { z } from 'zod';
import { canonicalTransactionHash, chainSchema, resolveChainIdentifier } from './contracts.js';

// Provider notifications carry lookup hints only. In particular, amounts, owners,
// confirmation counts and asset identities are deliberately absent.
export const exchangeDiscoverySchema = z
  .object({
    schemaVersion: z.literal(1),
    resetEpoch: z.string().min(1).max(128),
    discoveryId: z.string().min(1).max(256),
    chain: z
      .string()
      .transform((value) => resolveChainIdentifier(value) ?? value)
      .pipe(chainSchema),
    network: z.string().min(1).max(128),
    transactionHash: z.string().min(1).max(128),
    walletId: z.uuid().optional(),
    registryRevision: z.number().int().positive().optional(),
    source: z.enum(['live', 'backfill', 'reconcile']),
  })
  .strict()
  .transform((signal) => ({
    ...signal,
    transactionHash: canonicalTransactionHash(signal.chain, signal.transactionHash),
  }));

export type ExchangeDiscoverySignal = z.infer<typeof exchangeDiscoverySchema>;
