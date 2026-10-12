import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { executionDigest } from './execution-authorization.js';
import { tokenCertificateSchema } from './token-contracts.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(128);
const wallet = {
  walletId: z.uuid(),
  address: z.string().min(20).max(100),
  path: z.string().min(1).max(256),
  registryRevision: z.number().int().positive(),
};
const common = {
  version: z.literal(1),
  domainId: identity,
  resetEpoch: identity,
  seedId: identity,
  customerId: z.uuid(),
  operationId: z.uuid(),
  attemptId: z.uuid(),
  requestDigest: digest,
  preparationDigest: digest,
  requestHash: digest,
  certificate: tokenCertificateSchema,
  policyVersion: z.literal('exchange-token-v1'),
  recipientPolicy: z.literal('external-wallet-v1'),
  expiresAt: z.iso.datetime({ offset: true }),
  // Present only for management1-sponsored SPL sweeps; native Ethereum gas is paid by the source.
  sponsor: z
    .object({ ...wallet, role: z.literal('management'), account: z.literal(1) })
    .strict()
    .optional(),
};
export const tokenExecutionClaimsSchema = z.discriminatedUnion('purpose', [
  z
    .object({
      ...common,
      purpose: z.literal('token_sweep'),
      source: z
        .object({
          ...wallet,
          role: z.literal('customer_deposit'),
          account: z.number().int().min(10).max(2147483647),
        })
        .strict(),
      target: z
        .object({
          ...wallet,
          role: z.literal('hot'),
          account: z.literal(0),
          seedId: identity,
          domainId: identity,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      purpose: z.literal('token_withdrawal'),
      source: z.object({ ...wallet, role: z.literal('hot'), account: z.literal(0) }).strict(),
      target: z
        .object({ role: z.literal('external'), address: z.string().min(20).max(100) })
        .strict(),
      reservationId: z.uuid(),
    })
    .strict(),
]);
export const tokenExecutionAuthorizationSchema = z
  .object({
    claims: tokenExecutionClaimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type TokenExecutionClaims = z.infer<typeof tokenExecutionClaimsSchema>;
export type TokenExecutionAuthorization = z.infer<typeof tokenExecutionAuthorizationSchema>;
const payload = (claims: TokenExecutionClaims) =>
  Buffer.from('exchange-token-authorization-v1:' + executionDigest(claims));

export function signTokenExecutionAuthorization(
  claims: TokenExecutionClaims,
  key: KeyObject | string | Buffer,
): TokenExecutionAuthorization {
  const parsed = tokenExecutionClaimsSchema.parse(claims),
    privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Token authority must use an Ed25519 private key');
  return {
    claims: parsed,
    signature: sign(null, payload(parsed), privateKey).toString('base64url'),
  };
}

export function verifyTokenExecutionAuthorization(
  auth: TokenExecutionAuthorization,
  key: KeyObject | string | Buffer,
): TokenExecutionClaims {
  const parsed = tokenExecutionAuthorizationSchema.parse(auth),
    publicKey = key instanceof KeyObject ? key : createPublicKey(key);
  if (
    publicKey.type !== 'public' ||
    publicKey.asymmetricKeyType !== 'ed25519' ||
    !verify(null, payload(parsed.claims), publicKey, Buffer.from(parsed.signature, 'base64url'))
  )
    throw new Error('Invalid token execution authorization');
  return parsed.claims;
}
