import { z } from 'zod';
import { executionDigest, executionUnitsSchema } from './execution-authorization.js';
import { executionAssetSchema } from './execution-contracts.js';

const positive = executionUnitsSchema.refine((v) => BigInt(v) > 0n);
const member = z
  .object({
    operationId: z.uuid(),
    attemptId: z.uuid(),
    reservationId: z.uuid(),
    customerId: z.uuid(),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    destination: z.string().min(20).max(256),
    principalUnits: positive,
    maximumFeeUnits: executionUnitsSchema,
    maximumRentUnits: executionUnitsSchema,
  })
  .strict();

/** No queue command or generic contract call is admitted by this planning contract. */
export const payoutBatchManifestSchema = z
  .object({
    version: z.literal(1),
    batchId: z.uuid(),
    domainId: z.string().min(1).max(128),
    resetEpoch: z.string().min(1).max(128),
    seedId: z.string().min(1).max(64),
    sourceWalletId: z.uuid(),
    sourceRegistryRevision: z.number().int().positive(),
    sourceAddress: z.string().min(20).max(256),
    asset: executionAssetSchema,
    // Member order is the exact output/instruction order and fee remainder tie-break.
    members: z.array(member).min(2).max(50),
    feeAllocation: z.literal('equal-largest-remainder-v1'),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const { asset, members } = manifest;
    const bitcoin =
      asset.chain === 'bitcoin' &&
      asset.network === 'regtest' &&
      asset.assetId === 'token:bitcoin:native';
    const solana =
      asset.chain === 'solana' &&
      asset.network === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' &&
      (asset.assetId === 'token:solana:native' || asset.assetId.startsWith('token:solana:spl:'));
    if (!bitcoin && !solana)
      ctx.addIssue({
        code: 'custom',
        message: 'Batch asset/network is not supported; EVM batch calls are prohibited',
      });
    if (solana && members.length > 20)
      ctx.addIssue({ code: 'custom', message: 'Solana batch member limit exceeded' });
    for (const key of ['operationId', 'attemptId', 'reservationId'] as const)
      if (new Set(members.map((m) => m[key])).size !== members.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate batch ${key}` });
    if (members.some((m, i) => i > 0 && members[i - 1].operationId >= m.operationId))
      ctx.addIssue({
        code: 'custom',
        message: 'Batch members must be in canonical operation order',
      });
    if (members.some((m) => m.destination === manifest.sourceAddress))
      ctx.addIssue({ code: 'custom', message: 'Batch recipient cannot be its hot source' });
    if (
      members.some(
        (m) =>
          BigInt(m.principalUnits) > 0xffffffffffffffffn ||
          (bitcoin && BigInt(m.principalUnits) < 546n),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Batch principal is outside transfer limits' });
    if (members.reduce((n, m) => n + BigInt(m.principalUnits), 0n) > 0xffffffffffffffffn)
      ctx.addIssue({ code: 'custom', message: 'Batch principal total exceeds uint64' });
    if (
      (bitcoin || asset.assetId.endsWith(':native')) &&
      members.some((m) => m.maximumRentUnits !== '0')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native batches cannot authorize token account rent',
      });
  });
export type PayoutBatchManifest = z.infer<typeof payoutBatchManifestSchema>;

export function payoutBatchDigest(manifest: PayoutBatchManifest): string {
  return executionDigest(payoutBatchManifestSchema.parse(manifest));
}

/** Integer-only, deterministic and conserving: never charge the full fee to every member. */
export function allocateBatchCosts(
  manifest: PayoutBatchManifest,
  actualFeeUnits: string,
  rentByOperation: ReadonlyMap<string, string> = new Map(),
) {
  manifest = payoutBatchManifestSchema.parse(manifest);
  const fee = BigInt(executionUnitsSchema.parse(actualFeeUnits));
  const count = BigInt(manifest.members.length);
  const floor = fee / count,
    remainder = fee % count;
  const known = new Set(manifest.members.map((m) => m.operationId));
  for (const key of rentByOperation.keys())
    if (!known.has(key)) throw new Error('Rent belongs to a nonmember operation');
  const shares = manifest.members.map((m, index) => {
    const feeUnits = floor + (BigInt(index) < remainder ? 1n : 0n);
    const rentUnits = BigInt(executionUnitsSchema.parse(rentByOperation.get(m.operationId) ?? '0'));
    if (feeUnits > BigInt(m.maximumFeeUnits) || rentUnits > BigInt(m.maximumRentUnits))
      throw new Error('Actual batch cost exceeds an original member budget');
    return {
      operationId: m.operationId,
      attemptId: m.attemptId,
      reservationId: m.reservationId,
      memberIndex: index,
      principalUnits: m.principalUnits,
      feeUnits: feeUnits.toString(),
      rentUnits: rentUnits.toString(),
    };
  });
  return shares;
}

/** Member mapping is explicit because Bitcoin change occupies output 1 in Wallet Core. */
export function mapBatchOutputs(manifest: PayoutBatchManifest, bitcoinChangeUnits = '0') {
  manifest = payoutBatchManifestSchema.parse(manifest);
  const change = BigInt(executionUnitsSchema.parse(bitcoinChangeUnits));
  if (manifest.asset.chain !== 'bitcoin' && change !== 0n)
    throw new Error('Solana has no Bitcoin change output');
  if (change > 0n && change < 546n) throw new Error('Bitcoin batch change is dust');
  return manifest.members.map((m, index) => ({
    operationId: m.operationId,
    attemptId: m.attemptId,
    reservationId: m.reservationId,
    outputIndex: index + (change > 0n && index > 0 ? 1 : 0),
    destination: m.destination,
    principalUnits: m.principalUnits,
  }));
}

export const evmWindowAllocationSchema = z
  .object({
    attemptId: z.uuid(),
    nonce: executionUnitsSchema,
    assetId: z.string().regex(/^token:ethereum:(?:native|erc20:0x[0-9a-f]{40})$/),
    principalUnits: positive,
    maximumFeeUnits: executionUnitsSchema,
    state: z.enum(['prepared', 'signed', 'submitted', 'uncertain', 'reverted']),
  })
  .strict();
export type EvmWindowAllocation = z.infer<typeof evmWindowAllocationSchema>;
export type EvmWindowSnapshot = {
  latestNonce: string;
  pendingNonce: string;
  // These are canonical, independently observed balances; incoming pending funds cannot finance payouts.
  nativeFinalizedUnits: string;
  nativePendingUnits: string;
  tokenBalances: ReadonlyMap<string, { finalizedUnits: string; pendingUnits: string }>;
};

/** A conservative reservation decision, not proof that an earlier nonce paid its obligation. */
export function planEvmWindow(
  snapshot: EvmWindowSnapshot,
  retained: readonly EvmWindowAllocation[],
  proposed: Omit<EvmWindowAllocation, 'nonce' | 'state'>,
  limit: number,
): EvmWindowAllocation {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
    throw new Error('EVM window limit must be 1..16');
  const latest = BigInt(executionUnitsSchema.parse(snapshot.latestNonce));
  const pending = BigInt(executionUnitsSchema.parse(snapshot.pendingNonce));
  const allocations = retained.map((a) => evmWindowAllocationSchema.parse(a));
  if (allocations.length >= limit) throw new Error('EVM withdrawal window is full');
  if (
    new Set(allocations.map((a) => a.attemptId)).size !== allocations.length ||
    new Set(allocations.map((a) => a.nonce)).size !== allocations.length
  )
    throw new Error('Retained EVM allocation identity collision');
  if (allocations.some((a) => a.attemptId === proposed.attemptId))
    throw new Error('Attempt already has an EVM allocation');
  if (pending < latest || pending - latest > BigInt(limit))
    throw new Error('External or excessive pending nonce advance');
  if (
    allocations.some((a) => BigInt(a.nonce) < latest || BigInt(a.nonce) >= latest + BigInt(limit))
  )
    throw new Error('Retained nonce requires canonical reconciliation');
  // Every occupied RPC slot must have retained signed exposure; never infer payment from a count.
  for (let nonce = latest; nonce < pending; nonce++) {
    const a = allocations.find((a) => BigInt(a.nonce) === nonce);
    if (!a || !['signed', 'submitted', 'uncertain'].includes(a.state))
      throw new Error('Untracked pending EVM nonce');
  }
  let nonce = latest;
  const occupied = new Set(allocations.map((a) => a.nonce));
  while (occupied.has(nonce.toString())) nonce++;
  if (nonce >= latest + BigInt(limit)) throw new Error('EVM nonce distance exceeded');
  const result = evmWindowAllocationSchema.parse({
    ...proposed,
    nonce: nonce.toString(),
    state: 'prepared',
  });
  if (BigInt(result.maximumFeeUnits) > 5_000_000_000_000_000n)
    throw new Error('EVM fee budget exceeds transfer policy');
  const all = [...allocations, result];
  const nativeRequired = all.reduce(
    (sum, a) =>
      sum +
      BigInt(a.maximumFeeUnits) +
      (a.assetId === 'token:ethereum:native' ? BigInt(a.principalUnits) : 0n),
    0n,
  );
  const nativeFinalized = BigInt(executionUnitsSchema.parse(snapshot.nativeFinalizedUnits));
  const nativePending = BigInt(executionUnitsSchema.parse(snapshot.nativePendingUnits));
  if (nativeRequired > nativeFinalized || nativeRequired > nativePending)
    throw new Error('Insufficient unreserved native principal/gas liquidity');
  for (const assetId of new Set(
    all.map((a) => a.assetId).filter((id) => id !== 'token:ethereum:native'),
  )) {
    const balance = snapshot.tokenBalances.get(assetId);
    if (!balance) throw new Error('Missing canonical token liquidity');
    const required = all
      .filter((a) => a.assetId === assetId)
      .reduce((sum, a) => sum + BigInt(a.principalUnits), 0n);
    if (
      required > BigInt(executionUnitsSchema.parse(balance.finalizedUnits)) ||
      required > BigInt(executionUnitsSchema.parse(balance.pendingUnits))
    )
      throw new Error('Insufficient unreserved token liquidity');
  }
  return result;
}
