import { z } from 'zod';

export const chainSchema = z.enum(['ethereum', 'bitcoin', 'solana']);
export type Chain = z.infer<typeof chainSchema>;
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78)
  .pipe(z.string().refine((v) => BigInt(v) < 1n << 256n, 'Exceeds uint256'));
const positive = uint.pipe(z.string().refine((v) => BigInt(v) > 0n, 'Must be positive'));
const sats = positive.pipe(
  z.string().refine((v) => BigInt(v) <= 2_100_000_000_000_000n, 'Exceeds Bitcoin supply'),
);
const u64 = positive.pipe(
  z.string().refine((v) => BigInt(v) <= 18_446_744_073_709_551_615n, 'Exceeds uint64'),
);
const address = z.string().min(20).max(100);
const ethAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const outpoint = z
  .object({
    txid: z.string().regex(/^[0-9a-f]{64}$/),
    vout: z.number().int().min(0).max(0xffffffff),
  })
  .strict();
export const walletRequest = z
  .object({ chain: chainSchema, externalId: z.string().min(1).max(128) })
  .strict();
export const transferSchema = z.discriminatedUnion('chain', [
  z
    .object({
      chain: z.literal('ethereum'),
      to: ethAddress,
      amount: positive,
      maxFeePerGas: positive,
      maxPriorityFeePerGas: positive,
    })
    .strict(),
  z
    .object({
      chain: z.literal('bitcoin'),
      outputs: z
        .array(z.object({ address, amount: sats }).strict())
        .min(1)
        .max(50),
      utxos: z.array(outpoint).min(1).max(100),
      satsPerVbyte: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      chain: z.literal('solana'),
      outputs: z
        .array(z.object({ address, amount: u64 }).strict())
        .min(1)
        .max(20),
    })
    .strict(),
]);
export type Transfer = z.infer<typeof transferSchema>;
export const accountSchema = z.number().int().min(0).max(0x7fffffff);
export const deriveSchema = z
  .object({ chain: chainSchema, account: accountSchema, seedId: z.string().min(1).max(64) })
  .strict();
export type DeriveRequest = z.infer<typeof deriveSchema>;
export const signSchema = z
  .object({
    wallet: deriveSchema.extend({ address }),
    transaction: z.discriminatedUnion('chain', [
      z
        .object({
          chain: z.literal('ethereum'),
          chainId: positive,
          nonce: uint,
          to: ethAddress,
          amount: positive,
          gasLimit: positive,
          maxFeePerGas: positive,
          maxPriorityFeePerGas: positive,
        })
        .strict(),
      z
        .object({
          chain: z.literal('bitcoin'),
          outputs: z
            .array(z.object({ address, amount: sats }).strict())
            .min(1)
            .max(50),
          utxos: z
            .array(
              outpoint.extend({
                amount: sats,
                script: z
                  .string()
                  .regex(/^[0-9a-f]+$/)
                  .max(10000),
              }),
            )
            .min(1)
            .max(100),
          satsPerVbyte: z.number().int().min(1).max(1000),
        })
        .strict(),
      z
        .object({
          chain: z.literal('solana'),
          outputs: z
            .array(z.object({ address, amount: u64 }).strict())
            .min(1)
            .max(20),
          recentBlockhash: z.string().min(32).max(44),
          lastValidBlockHeight: z.number().int().positive(),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((v) => v.wallet.chain === v.transaction.chain, 'Chain mismatch');
export type SignRequest = z.infer<typeof signSchema>;
export interface SignedTransaction {
  raw: string;
  txHash: string;
  encoding: 'hex' | 'base64';
}
export const signedSchema = z
  .object({
    raw: z.string().min(1),
    txHash: z.string().min(1),
    encoding: z.enum(['hex', 'base64']),
  })
  .strict();
export function derivationPath(chain: Chain, account: number): string {
  accountSchema.parse(account);
  if (chain === 'solana') return `m/44'/501'/${account}'/0'`;
  return chain === 'bitcoin' ? `m/84'/0'/${account}'/0/0` : `m/44'/60'/${account}'/0/0`;
}
