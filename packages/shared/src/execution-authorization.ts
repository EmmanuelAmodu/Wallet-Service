import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { z } from 'zod';
import { signSchema, SignRequest } from './contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(128);
export const executionUnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((n) => BigInt(n) < 1n << 256n);
export const nativeExecutionAssetSchema = z
  .object({
    chain: z.enum(['ethereum', 'bitcoin', 'solana']),
    network: identity,
    assetId: z.enum(['token:ethereum:native', 'token:bitcoin:native', 'token:solana:native']),
  })
  .strict()
  .refine((a) => a.assetId === `token:${a.chain}:native`, 'Native asset chain mismatch');
const walletIdentity = {
  walletId: z.uuid(),
  account: z.number().int(),
  path: z.string().min(1).max(256),
  address: z.string().min(1).max(256),
  registryRevision: z.number().int().positive(),
};
export const executionAuthorizationClaimsSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('native_sweep'),
    domainId: identity,
    resetEpoch: identity,
    seedId: z.string().min(1).max(64),
    customerId: z.uuid(),
    source: z
      .object({
        ...walletIdentity,
        role: z.literal('customer_deposit'),
        account: z.number().int().min(10).max(2147483647),
      })
      .strict(),
    target: z
      .object({
        ...walletIdentity,
        role: z.literal('hot'),
        account: z.literal(0),
        seedId: z.string().min(1).max(64),
        domainId: identity,
      })
      .strict(),
    asset: nativeExecutionAssetSchema,
    policyVersion: z.literal('exchange-financial-v1'),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    requestDigest: digest,
    preparationDigest: digest,
    principalUnits: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
    maxFeeUnits: executionUnitsSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    requestHash: digest,
  })
  .strict();
export type ExecutionAuthorizationClaims = z.infer<typeof executionAuthorizationClaimsSchema>;
export const signedExecutionAuthorizationSchema = z
  .object({
    claims: executionAuthorizationClaimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignedExecutionAuthorization = z.infer<typeof signedExecutionAuthorizationSchema>;
export const signerAttestationClaimsSchema = z
  .object({
    version: z.literal(1),
    domainId: identity,
    resetEpoch: identity,
    transactionId: z.uuid(),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    requestDigest: digest,
    preparationDigest: digest,
    status: z.enum(['signed', 'rejected']),
    resultDigest: digest,
  })
  .strict();
export type SignerAttestationClaims = z.infer<typeof signerAttestationClaimsSchema>;
export const signerAttestationSchema = z
  .object({
    claims: signerAttestationClaimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignerAttestation = z.infer<typeof signerAttestationSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  throw new Error('Execution digest requires a canonical JSON value');
}

export function executionDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function executionRequestDigest(request: SignRequest): string {
  return executionDigest(signSchema.parse(request));
}

function ed25519Key(value: string | Buffer | KeyObject, privateKey: boolean): KeyObject {
  const key =
    value instanceof KeyObject
      ? value
      : privateKey
        ? createPrivateKey(value)
        : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519' || (privateKey && key.type !== 'private'))
    throw new Error('Execution keys must be Ed25519');
  return key;
}

function signClaims(claims: unknown, key: string | Buffer | KeyObject): string {
  return sign(null, Buffer.from(canonical(claims)), ed25519Key(key, true)).toString('base64url');
}

function verifyClaims(claims: unknown, signature: string, key: string | Buffer | KeyObject): void {
  if (
    !verify(
      null,
      Buffer.from(canonical(claims)),
      ed25519Key(key, false),
      Buffer.from(signature, 'base64url'),
    )
  )
    throw new Error('Invalid execution signature');
}

export function signExecutionAuthorization(
  claims: ExecutionAuthorizationClaims,
  key: string | Buffer | KeyObject,
): SignedExecutionAuthorization {
  const parsed = executionAuthorizationClaimsSchema.parse(claims);
  return { claims: parsed, signature: signClaims(parsed, key) };
}
export function verifyExecutionAuthorization(
  value: SignedExecutionAuthorization,
  key: string | Buffer | KeyObject,
): ExecutionAuthorizationClaims {
  const parsed = signedExecutionAuthorizationSchema.parse(value);
  verifyClaims(parsed.claims, parsed.signature, key);
  return parsed.claims;
}
export function signSignerAttestation(
  claims: SignerAttestationClaims,
  key: string | Buffer | KeyObject,
): SignerAttestation {
  const parsed = signerAttestationClaimsSchema.parse(claims);
  return { claims: parsed, signature: signClaims(parsed, key) };
}
export function verifySignerAttestation(
  value: SignerAttestation,
  result: unknown,
  key: string | Buffer | KeyObject,
): SignerAttestationClaims {
  const parsed = signerAttestationSchema.parse(value);
  verifyClaims(parsed.claims, parsed.signature, key);
  if (parsed.claims.resultDigest !== executionDigest(result))
    throw new Error('Signer attestation result mismatch');
  if (result && typeof result === 'object') {
    const message = result as Record<string, unknown>;
    if (
      message.type === 'transaction.custody.signed' ||
      message.type === 'transaction.custody.rejected'
    ) {
      const status = message.type === 'transaction.custody.signed' ? 'signed' : 'rejected';
      if (
        parsed.claims.status !== status ||
        ['transactionId', 'operationId', 'attemptId', 'requestDigest', 'preparationDigest'].some(
          (key) => message[key] !== parsed.claims[key as keyof SignerAttestationClaims],
        )
      )
        throw new Error('Signer attestation binding mismatch');
    }
  }
  return parsed.claims;
}
