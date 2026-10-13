import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ledgerActivitySchema,
  processorActivitySchema,
} from '../../shared/src/activity-contracts.js';
import { deriveSchema, signSchema, signedSchema, chainSchema } from '../../shared/src/contracts.js';
import { matches, token } from '../../shared/src/security/tokens.js';
import { exchangeEventSchema, ExchangeEvent } from './exchange-contracts.js';
import { exchangeDiscoverySchema } from '../../shared/src/exchange-discovery.js';
import {
  custodySignSchema,
  tokenCustodySignSchema,
  custodySignedSchema,
  custodyRejectedSchema,
} from '../../shared/src/execution-contracts.js';
import {
  tokenPreparationSchema,
  tokenSignRequestSchema,
} from '../../shared/src/token-contracts.js';
import { signerAttestationSchema } from '../../shared/src/execution-authorization.js';

export const QUEUES = {
  wallet: 'wallet-actions',
  signer: 'signer-actions',
  broadcast: 'broadcast-actions',
  activity: 'activity-actions',
  ledger: 'ledger-actions',
  sweep: 'sweep-actions',
} as const;
export const derivationBindingSchema = z
  .object({
    walletId: z.uuid(),
    requestId: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    domainId: z.string().min(1).max(128),
    network: z.string().min(1).max(128),
    role: z.enum(['legacy', 'hot', 'management', 'customer_deposit']),
    path: z.string().min(1).max(256),
    request: deriveSchema,
  })
  .strict();
export type DerivationBinding = z.infer<typeof derivationBindingSchema>;

export function derivationRequestDigest(input: Omit<DerivationBinding, 'requestDigest'>) {
  return createHash('sha256')
    .update(
      canonical({
        walletId: input.walletId,
        requestId: input.requestId,
        domainId: input.domainId,
        network: input.network,
        role: input.role,
        path: input.path,
        request: input.request,
      }),
    )
    .digest('hex');
}

function validDerivationBinding(input: DerivationBinding) {
  return (
    input.requestDigest === derivationRequestDigest(input) &&
    (input.role === 'hot'
      ? input.request.account === 0
      : input.role === 'management'
        ? input.request.account >= 1 && input.request.account <= 9
        : input.request.account >= 10)
  );
}

export const walletDeriveSchema = derivationBindingSchema
  .extend({
    type: z.literal('wallet.derive'),
  })
  .strict()
  .refine(validDerivationBinding, 'Invalid derivation identity or account role');
export const walletDerivedSchema = derivationBindingSchema
  .extend({
    type: z.literal('wallet.derived'),
    address: z.string().min(1).max(256),
  })
  .strict()
  .refine(validDerivationBinding, 'Invalid derivation identity or account role');
export const walletRejectedSchema = derivationBindingSchema
  .extend({
    type: z.literal('wallet.rejected'),
  })
  .strict()
  .refine(validDerivationBinding, 'Invalid derivation identity or account role');
export const executionBindingSchema = z
  .object({
    operationId: z.uuid(),
    attemptId: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    preparationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const broadcastSnapshotSchema = z
  .object({
    chain: chainSchema,
    network: z.string().min(1),
    signed: signedSchema,
    lastValidBlockHeight: z.number().int().nonnegative().optional(),
    execution: executionBindingSchema
      .extend({
        domainId: z.string().min(1).max(128),
        resetEpoch: z.string().min(1).max(128),
        preparedRequest: z.union([signSchema, tokenSignRequestSchema]),
        tokenPreparation: tokenPreparationSchema.optional(),
        signerAttestation: signerAttestationSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.chain === 'solana' && value.lastValidBlockHeight === undefined)
      ctx.addIssue({ code: 'custom', message: 'Solana expiry height required' });
  });
const legacyMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('custody.assignment.issue'),
      commandId: z.uuid(),
      domainId: z.string().min(1).max(128),
      assignmentId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('custody.bootstrap'),
      commandId: z.uuid(),
      domainId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('custody.management.create'),
      commandId: z.uuid(),
      domainId: z.string().min(1).max(128),
      chain: z.enum(['ethereum', 'bitcoin', 'solana']),
      network: z.string().min(1).max(128),
      account: z.number().int().min(1).max(9),
    })
    .strict(),
  z
    .object({ type: z.literal('exchange.discovery.received'), discovery: exchangeDiscoverySchema })
    .strict(),
  z
    .object({
      type: z.literal('exchange.discovery.check'),
      discoveryId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  walletDeriveSchema,
  walletDerivedSchema,
  walletRejectedSchema,
  custodySignSchema,
  tokenCustodySignSchema,
  custodySignedSchema,
  custodyRejectedSchema,
  z.object({ type: z.literal('execution.reconcile'), transactionId: z.uuid() }).strict(),
  z.object({ type: z.literal('transaction.prepare'), transactionId: z.uuid() }).strict(),
  z
    .object({ type: z.literal('transaction.sign'), transactionId: z.uuid(), request: signSchema })
    .strict(),
  z
    .object({
      type: z.literal('transaction.signed'),
      transactionId: z.uuid(),
      signed: signedSchema,
    })
    .strict(),
  z.object({ type: z.literal('transaction.rejected'), transactionId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal('broadcast.requested'),
      snapshot: broadcastSnapshotSchema,
      transactionId: z.uuid(),
      generation: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('broadcast.confirm'),
      snapshot: broadcastSnapshotSchema.optional(),
      transactionId: z.uuid(),
      generation: z.number().int().nonnegative(),
      poll: z.number().int().nonnegative(),
      monitorId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('broadcast.updated'),
      transactionId: z.uuid(),
      generation: z.number().int().nonnegative(),
      revision: z.number().int().positive(),
      status: z.enum(['queued', 'broadcasting', 'submitted', 'confirmed', 'failed', 'attention']),
      attempts: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
      execution: executionBindingSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('activity.received'),
      pubsubMessageId: z.string().min(1),
      activity: processorActivitySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('activity.check-finality'),
      activity: processorActivitySchema,
      poll: z.number().int().nonnegative(),
      blockHash: z.string().optional(),
      previouslyIncluded: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('activity.invalid'),
      pubsubMessageId: z.string().min(1),
      reason: z.string().min(1).max(500),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      payload: z.string().max(65536),
    })
    .strict(),
  z
    .object({
      type: z.literal('ledger.wallet.registered'),
      walletId: z.uuid(),
      chain: chainSchema,
      network: z.string().min(1),
      address: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal('ledger.activity.update'), activity: ledgerActivitySchema }).strict(),
]);
export const messageSchema = z.union([legacyMessageSchema, exchangeEventSchema]);
export type Message = z.infer<typeof messageSchema>;
export function isExchangeEvent(message: Message): message is ExchangeEvent {
  return 'schemaVersion' in message;
}
const queueEnvelopeSchema = z
  .object({
    version: z.literal(2),
    id: z.string(),
    resetEpoch: z.string().min(1).max(128),
    payload: messageSchema,
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export class MessageAuth {
  constructor(
    private readonly key: string,
    readonly resetEpoch = 'test-epoch',
  ) {
    token(key);
    if (!resetEpoch || resetEpoch.length > 128) throw new Error('Invalid reset epoch');
  }

  seal(payload: Message, id: string = randomUUID()) {
    if ('resetEpoch' in payload && payload.resetEpoch !== this.resetEpoch)
      throw new Error('Stale business reset epoch');
    const body = { version: 2 as const, id, resetEpoch: this.resetEpoch, payload };
    return { ...body, mac: createHmac('sha256', this.key).update(canonical(body)).digest('hex') };
  }

  open(data: unknown, jobId: string, name: string): Message {
    const envelope = queueEnvelopeSchema.parse(data);
    if (envelope.resetEpoch !== this.resetEpoch) throw new Error('Stale reset epoch');
    const expected = this.seal(envelope.payload, envelope.id);
    if (
      envelope.id !== jobId ||
      envelope.payload.type !== name ||
      !matches(envelope.mac, expected.mac)
    )
      throw new Error('Invalid queue message authentication');
    return envelope.payload;
  }
}
