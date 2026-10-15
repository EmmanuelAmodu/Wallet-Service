import { z } from 'zod';
import { KeyObject, sign, verify } from 'node:crypto';
import { bech32 } from 'bech32';
import { signSchema, signedSchema } from './contracts.js';
import {
  executionDigest,
  executionUnitsSchema,
  signerAttestationSchema,
} from './execution-authorization.js';
import {
  payoutBatchManifestSchema,
  payoutBatchDigest,
  mapBatchOutputs,
  allocateBatchCosts,
} from './payout-policy.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const units = executionUnitsSchema;
const mapping = z
  .object({
    operationId: z.uuid(),
    attemptId: z.uuid(),
    reservationId: z.uuid(),
    outputIndex: z.number().int().nonnegative(),
    destination: z.string(),
    principalUnits: units,
  })
  .strict();
const cost = z
  .object({
    operationId: z.uuid(),
    attemptId: z.uuid(),
    reservationId: z.uuid(),
    memberIndex: z.number().int().nonnegative(),
    principalUnits: units,
    feeUnits: units,
    rentUnits: units,
  })
  .strict();
export const bitcoinBatchPreparationSchema = z
  .object({
    version: z.literal(1),
    batchId: z.uuid(),
    manifestDigest: digest,
    request: signSchema,
    requestDigest: digest,
    principalUnits: units,
    feeUnits: units,
    changeUnits: units,
    changeOutputIndex: z.literal(1),
    memberOutputs: z.array(mapping).min(2).max(50),
    memberCosts: z.array(cost).min(2).max(50),
    resourceKeys: z.array(z.string()).min(1).max(100),
    expiresAt: z.iso.datetime({ offset: true }),
    preparationDigest: digest,
  })
  .strict();
export type BitcoinBatchPreparation = z.infer<typeof bitcoinBatchPreparationSchema>;

/** Shared independent verification, not financial approval or proof of current UTXO availability. */
export function validateBitcoinBatch(manifestInput: unknown, preparationInput: unknown) {
  const manifest = payoutBatchManifestSchema.parse(manifestInput);
  const preparation = bitcoinBatchPreparationSchema.parse(preparationInput);
  const { preparationDigest, ...body } = preparation;
  const tx = preparation.request.transaction,
    wallet = preparation.request.wallet;
  const same = (a: unknown, b: unknown) => executionDigest(a) === executionDigest(b);
  if (
    manifest.asset.chain !== 'bitcoin' ||
    tx.chain !== 'bitcoin' ||
    wallet.chain !== 'bitcoin' ||
    wallet.network !== 'regtest' ||
    wallet.seedId !== manifest.seedId ||
    wallet.account !== 0 ||
    wallet.address !== manifest.sourceAddress ||
    preparation.batchId !== manifest.batchId ||
    preparation.manifestDigest !== payoutBatchDigest(manifest) ||
    preparationDigest !== executionDigest(body) ||
    preparation.requestDigest !== executionDigest(preparation.request)
  )
    throw new Error('Bitcoin batch preparation binding mismatch');
  const script = (address: string) => {
    const decoded = bech32.decode(address, 90),
      program = bech32.fromWords(decoded.words.slice(1));
    if (
      decoded.prefix !== 'bcrt' ||
      decoded.words[0] !== 0 ||
      program.length !== 20 ||
      bech32.encode('bcrt', decoded.words) !== address
    )
      throw new Error('Bitcoin batch requires canonical regtest P2WPKH addresses');
    return '0014' + Buffer.from(program).toString('hex');
  };
  const owned = script(manifest.sourceAddress);
  for (const member of manifest.members) script(member.destination);
  const principal = manifest.members.reduce((sum, m) => sum + BigInt(m.principalUnits), 0n);
  const keys = tx.utxos.map((u) => `utxo:${u.txid}:${u.vout}`);
  if (
    tx.sweepAll ||
    tx.changeAmount !== preparation.changeUnits ||
    BigInt(preparation.changeUnits) < 546n ||
    tx.satsPerVbyte > 100 ||
    preparation.principalUnits !== principal.toString() ||
    BigInt(preparation.feeUnits) < 1n ||
    BigInt(preparation.feeUnits) > 10000n ||
    new Set(keys).size !== keys.length ||
    tx.utxos.some((u) => u.script !== owned || BigInt(u.amount) === 0n) ||
    !same(keys, preparation.resourceKeys) ||
    tx.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n) !==
      principal + BigInt(preparation.feeUnits) + BigInt(preparation.changeUnits) ||
    !same(
      tx.outputs,
      manifest.members.map((m) => ({ address: m.destination, amount: m.principalUnits })),
    ) ||
    !same(preparation.memberOutputs, mapBatchOutputs(manifest, preparation.changeUnits)) ||
    !same(preparation.memberCosts, allocateBatchCosts(manifest, preparation.feeUnits))
  )
    throw new Error('Bitcoin batch outputs, owned inputs or fee conservation mismatch');
  return { manifest, preparation };
}

const scope = {
  domainId: z.string().min(1).max(128),
  resetEpoch: z.string().min(1).max(128),
  batchId: z.uuid(),
};
export const payoutBatchLedgerCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('payout.batch.ledger.prepare'),
      ...scope,
      manifest: payoutBatchManifestSchema,
      preparation: bitcoinBatchPreparationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('payout.batch.ledger.settle'),
      ...scope,
      revision: z.number().int().positive(),
      transactionHash: z.string().regex(/^[0-9a-f]{64}$/),
      actualFeeUnits: units,
      blockHash: z.string().regex(/^[0-9a-f]{64}$/),
      blockHeight: units,
    })
    .strict(),
  z
    .object({
      type: z.literal('payout.batch.ledger.revert'),
      ...scope,
      revision: z.number().int().positive(),
      priorSettlementRevision: z.number().int().positive(),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);
export type PayoutBatchLedgerCommand = z.infer<typeof payoutBatchLedgerCommandSchema>;
export const payoutBatchLedgerResultSchema = z
  .object({
    type: z.literal('payout.batch.ledger.result'),
    ...scope,
    manifestDigest: digest,
    preparationDigest: digest,
    state: z.enum(['prepared', 'settled', 'reverted']),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const bitcoinBatchAuthorizationClaimsSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('bitcoin_withdrawal_batch'),
    domainId: z.string().min(1).max(128),
    resetEpoch: z.string().min(1).max(128),
    seedId: z.string().min(1).max(64),
    batchId: z.uuid(),
    transactionId: z.uuid(),
    manifestDigest: digest,
    preparationDigest: digest,
    sourcePath: z.string().min(1).max(256),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const bitcoinBatchAuthorizationSchema = z
  .object({
    claims: bitcoinBatchAuthorizationClaimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
type BatchClaims = z.infer<typeof bitcoinBatchAuthorizationClaimsSchema>;

function authorizationBytes(claims: BatchClaims) {
  return Buffer.from('waas:bitcoin-withdrawal-batch:v1:' + executionDigest(claims));
}

export function signBitcoinBatchAuthorization(claims: BatchClaims, key: KeyObject) {
  const parsed = bitcoinBatchAuthorizationClaimsSchema.parse(claims);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
    throw new Error('Batch authority requires an Ed25519 private key');
  return {
    claims: parsed,
    signature: sign(null, authorizationBytes(parsed), key).toString('base64url'),
  };
}
export function verifyBitcoinBatchAuthorization(
  input: z.infer<typeof bitcoinBatchAuthorizationSchema>,
  key: KeyObject,
) {
  const parsed = bitcoinBatchAuthorizationSchema.parse(input);
  if (
    key.type !== 'public' ||
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      authorizationBytes(parsed.claims),
      key,
      Buffer.from(parsed.signature, 'base64url'),
    )
  )
    throw new Error('Invalid independent Bitcoin batch authority');
  return parsed.claims;
}
export const bitcoinBatchSignSchema = z
  .object({
    type: z.literal('payout.batch.sign'),
    transactionId: z.uuid(),
    batchId: z.uuid(),
    manifest: payoutBatchManifestSchema,
    preparation: bitcoinBatchPreparationSchema,
    authorization: bitcoinBatchAuthorizationSchema,
  })
  .strict();
const resultBinding = {
  batchId: z.uuid(),
  transactionId: z.uuid(),
  manifestDigest: digest,
  preparationDigest: digest,
  signerAttestation: signerAttestationSchema,
};
export const bitcoinBatchSignedSchema = z
  .object({ type: z.literal('payout.batch.signed'), ...resultBinding, signed: signedSchema })
  .strict();
export const bitcoinBatchRejectedSchema = z
  .object({
    type: z.literal('payout.batch.rejected'),
    ...resultBinding,
    commandDigest: digest,
    reason: z.string().min(1).max(500),
  })
  .strict();
export type BitcoinBatchSignAction = z.infer<typeof bitcoinBatchSignSchema>;
export function bitcoinBatchAttestedResult(
  result:
    | Omit<z.infer<typeof bitcoinBatchSignedSchema>, 'signerAttestation'>
    | Omit<z.infer<typeof bitcoinBatchRejectedSchema>, 'signerAttestation'>,
) {
  const binding = {
    transactionId: result.transactionId,
    operationId: result.batchId,
    attemptId: result.batchId,
    requestDigest: result.manifestDigest,
    preparationDigest: result.preparationDigest,
  };
  return result.type === 'payout.batch.signed'
    ? { type: 'transaction.custody.signed' as const, ...binding, signed: result.signed }
    : {
        type: 'transaction.custody.rejected' as const,
        ...binding,
        reason: result.reason,
        commandDigest: result.commandDigest,
      };
}
