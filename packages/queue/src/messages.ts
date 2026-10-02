import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ledgerActivitySchema,
  processorActivitySchema,
} from '../../shared/src/activity-contracts.js';
import { deriveSchema, signSchema, signedSchema, chainSchema } from '../../shared/src/contracts.js';
import { matches, token } from '../../shared/src/security/tokens.js';

export const QUEUES = {
  wallet: 'wallet-actions',
  signer: 'signer-actions',
  broadcast: 'broadcast-actions',
  activity: 'activity-actions',
  ledger: 'ledger-actions',
} as const;
export const broadcastSnapshotSchema = z
  .object({
    chain: chainSchema,
    network: z.string().min(1),
    signed: signedSchema,
    lastValidBlockHeight: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.chain === 'solana' && value.lastValidBlockHeight === undefined)
      ctx.addIssue({ code: 'custom', message: 'Solana expiry height required' });
  });
export const messageSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('wallet.derive'), walletId: z.uuid(), request: deriveSchema })
    .strict(),
  z
    .object({
      type: z.literal('wallet.derived'),
      walletId: z.uuid(),
      address: z.string().min(1),
      path: z.string(),
    })
    .strict(),
  z.object({ type: z.literal('wallet.rejected'), walletId: z.uuid() }).strict(),
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
      tenantId: z.string().min(1),
      chain: chainSchema,
      network: z.string().min(1),
      address: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal('ledger.activity.update'), activity: ledgerActivitySchema }).strict(),
]);
export type Message = z.infer<typeof messageSchema>;
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
  constructor(private readonly key: string) {
    token(key);
  }

  seal(payload: Message, id: string = randomUUID()) {
    const body = { version: 1 as const, id, payload };
    return { ...body, mac: createHmac('sha256', this.key).update(canonical(body)).digest('hex') };
  }

  open(data: unknown, jobId: string, name: string): Message {
    const envelope = z
      .object({
        version: z.literal(1),
        id: z.string(),
        payload: messageSchema,
        mac: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(data);
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
