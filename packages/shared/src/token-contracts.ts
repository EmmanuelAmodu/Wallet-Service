import { z } from 'zod';
import { deriveSchema } from './contracts.js';
import { executionUnitsSchema } from './execution-authorization.js';

export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const SOLANA_DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => !/^0x0{40}$/i.test(v))
  .transform((v) => v.toLowerCase());
const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const positive = executionUnitsSchema.refine((v) => BigInt(v) > 0n);
const u64 = positive.refine((v) => BigInt(v) <= 18_446_744_073_709_551_615n);
const certificate = {
  certificateId: z.string().min(1).max(128),
  semantics: z.literal('exact-transfer'),
};

/** Explicit certification input; a configured address or ticker alone never certifies semantics. */
export const tokenCertificateSchema = z.discriminatedUnion('standard', [
  z
    .object({
      ...certificate,
      standard: z.literal('erc20'),
      chain: z.literal('ethereum'),
      network: z.literal('11155111'),
      contract: evmAddress,
      decimals: z.number().int().min(0).max(36),
      runtimeCodeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
      upgradePolicy: z.literal('immutable'),
    })
    .strict(),
  z
    .object({
      ...certificate,
      standard: z.literal('spl'),
      chain: z.literal('solana'),
      network: z.literal(SOLANA_DEVNET),
      mint: solanaAddress.refine((v) => v !== SOLANA_SYSTEM_PROGRAM),
      programId: z.literal(CLASSIC_TOKEN_PROGRAM),
      decimals: z.number().int().min(0).max(18),
      accountClosure: z.literal('retain'),
    })
    .strict(),
]);
export type TokenCertificate = z.infer<typeof tokenCertificateSchema>;

export function tokenAsset(certificate: TokenCertificate) {
  const c = tokenCertificateSchema.parse(certificate);
  return {
    chain: c.chain,
    network: c.network,
    assetId:
      c.standard === 'erc20'
        ? `token:ethereum:erc20:${c.contract}`
        : `token:solana:spl:${c.programId}:${c.mint}`,
  };
}

const wallet = deriveSchema
  .extend({
    address: z.string().min(20).max(100),
    network: z.string().min(1).max(128),
  })
  .strict();
const erc20 = z
  .object({
    kind: z.literal('erc20'),
    chain: z.literal('ethereum'),
    chainId: z.literal('11155111'),
    contract: evmAddress,
    recipient: evmAddress,
    amount: positive,
    nonce: executionUnitsSchema,
    gasLimit: positive.refine((v) => BigInt(v) >= 21000n && BigInt(v) <= 200000n),
    maxFeePerGas: positive.refine((v) => BigInt(v) <= 100_000_000_000n),
    maxPriorityFeePerGas: positive.refine((v) => BigInt(v) <= 2_000_000_000n),
  })
  .strict();
const spl = z
  .object({
    kind: z.literal('spl'),
    chain: z.literal('solana'),
    mint: solanaAddress,
    programId: z.literal(CLASSIC_TOKEN_PROGRAM),
    sourceTokenAccount: solanaAddress,
    recipientOwner: solanaAddress,
    recipientTokenAccount: solanaAddress,
    amount: u64,
    decimals: z.number().int().min(0).max(18),
    createRecipientAccount: z.boolean(),
    recentBlockhash: solanaAddress,
    lastValidBlockHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    // Management 1 sponsors sweeps; hot0 pays its own withdrawals. Never accept a raw key.
    feePayer: wallet.extend({
      chain: z.literal('solana'),
      account: z.union([z.literal(0), z.literal(1)]),
    }),
    accountClosure: z.literal('retain'),
  })
  .strict();
export const tokenSignRequestSchema = z
  .object({
    wallet,
    transaction: z.discriminatedUnion('kind', [erc20, spl]),
  })
  .strict()
  .superRefine((r, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (r.wallet.chain !== r.transaction.chain) reject('Token chain mismatch');
    if (r.transaction.kind === 'erc20') {
      if (r.wallet.network !== '11155111') reject('Token network mismatch');
      if (BigInt(r.transaction.maxPriorityFeePerGas) > BigInt(r.transaction.maxFeePerGas))
        reject('Priority fee exceeds maximum fee');
      if (r.transaction.recipient === r.wallet.address.toLowerCase()) reject('Self transfer');
    } else {
      const tx = r.transaction;
      if (r.wallet.network !== SOLANA_DEVNET || tx.feePayer.network !== SOLANA_DEVNET)
        reject('Token network mismatch');
      if (tx.feePayer.seedId !== r.wallet.seedId) reject('Fee payer seed mismatch');
      if (tx.recipientOwner === r.wallet.address || tx.recipientOwner === SOLANA_SYSTEM_PROGRAM)
        reject('Invalid token recipient');
      if (
        r.wallet.account === 0
          ? tx.feePayer.account !== 0
          : r.wallet.account < 10 || tx.feePayer.account !== 1
      )
        reject('Only management1 may sponsor customer sweeps; hot0 pays its own withdrawals');
    }
  });
export type TokenSignRequest = z.infer<typeof tokenSignRequestSchema>;

const assetIdentity = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
    network: z.string().min(1).max(128),
    assetId: z.string().min(1).max(256),
  })
  .strict();
export const tokenPreparationSchema = z
  .object({
    certificate: tokenCertificateSchema,
    certificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    request: tokenSignRequestSchema,
    principalAsset: assetIdentity,
    feeAsset: assetIdentity,
    maxFeeUnits: executionUnitsSchema,
    rentUnits: executionUnitsSchema,
    fundingShortfallUnits: executionUnitsSchema,
    resourceKeys: z.array(z.string().min(1).max(256)).min(2).max(4),
    expiresAt: z.iso.datetime({ offset: true }),
    preparedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const tokenExecutionAssetSchema = z.discriminatedUnion('chain', [
 z.object({chain:z.literal('ethereum'),network:z.literal('11155111'),assetId:z.string().regex(/^token:ethereum:erc20:0x[0-9a-f]{40}$/)}).strict(),
 z.object({chain:z.literal('solana'),network:z.literal(SOLANA_DEVNET),assetId:z.string().regex(/^token:solana:spl:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA:[1-9A-HJ-NP-Za-km-z]{32,44}$/)}).strict(),
]);

export const tokenCostsSchema = z.object({
 certificate:tokenCertificateSchema,feePayerWalletId:z.uuid(),feePayerRegistryRevision:z.number().int().positive(),
 maximumFeeUnits:executionUnitsSchema,maximumRentUnits:executionUnitsSchema,rentCustodyWalletId:z.uuid().optional(),
}).strict();
