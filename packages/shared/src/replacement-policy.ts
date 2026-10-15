import { signSchema, SignRequest } from './contracts.js';
import { tokenSignRequestSchema, TokenSignRequest } from './token-contracts.js';
import { executionDigest } from './execution-authorization.js';

type PaymentRequest = SignRequest | TokenSignRequest;
export type ReplacementConflict = {
  kind: 'evm_same_nonce' | 'bitcoin_same_inputs';
  originalRequestDigest: string;
  replacementRequestDigest: string;
  resourceKeys: string[];
  maximumFeeUnits: string;
};

function parse(value: PaymentRequest): PaymentRequest {
  return 'kind' in value.transaction
    ? tokenSignRequestSchema.parse(value)
    : signSchema.parse(value);
}

function same(a: unknown, b: unknown) {
  return executionDigest(a) === executionDigest(b);
}

function reject(message: string): never {
  throw new Error(`Replacement policy rejected: ${message}`);
}

/** Proves resource conflict, not nonpayment or financial authority. Original holds and fees still need independent admission. */
export function withdrawalReplacementConflict(
  original: PaymentRequest,
  replacement: PaymentRequest,
): ReplacementConflict {
  original = parse(original);
  replacement = parse(replacement);
  if (
    original.wallet.account !== 0 ||
    replacement.wallet.account !== 0 ||
    !same(original.wallet, replacement.wallet)
  )
    reject('replacement must retain the exact hot source, seed and network');
  const a = original.transaction,
    b = replacement.transaction;
  if (a.chain !== b.chain) reject('chain changed');
  if (a.chain === 'solana')
    reject(
      'fresh blockhash is independently payable; complete historical nonpayment proof is required',
    );
  if (a.chain === 'ethereum' && b.chain === 'ethereum' && 'nonce' in a && 'nonce' in b) {
    if (
      original.wallet.network !== '11155111' ||
      a.chainId !== '11155111' ||
      b.chainId !== '11155111'
    )
      reject('uncertified Ethereum network');
    if ('kind' in a !== 'kind' in b) reject('transfer type changed');
    const { maxFeePerGas: oldFee, maxPriorityFeePerGas: oldPriority, ...oldIntent } = a;
    const { maxFeePerGas: newFee, maxPriorityFeePerGas: newPriority, ...newIntent } = b;
    if (!same(oldIntent, newIntent))
      reject('nonce, principal, recipient, token call or gas limit changed');
    const increase = (value: string) => (BigInt(value) * 9n + 7n) / 8n;
    if (
      BigInt(newFee) < increase(oldFee) ||
      BigInt(newFee) <= BigInt(oldFee) ||
      BigInt(newPriority) < increase(oldPriority) ||
      BigInt(newPriority) <= BigInt(oldPriority)
    )
      reject('both EIP-1559 fee bounds must increase by the pinned 12.5 percent policy');
    const fee = BigInt(b.gasLimit) * BigInt(newFee);
    if (
      BigInt(newFee) > 100_000_000_000n ||
      BigInt(newPriority) > 2_000_000_000n ||
      BigInt(newPriority) > BigInt(newFee) ||
      fee > 5_000_000_000_000_000n
    )
      reject('replacement exceeds transfer fee budgets');
    return {
      kind: 'evm_same_nonce',
      originalRequestDigest: executionDigest(original),
      replacementRequestDigest: executionDigest(replacement),
      resourceKeys: [`nonce:${original.wallet.address.toLowerCase()}:${a.nonce}`],
      maximumFeeUnits: fee.toString(),
    };
  }
  if (a.chain === 'bitcoin' && b.chain === 'bitcoin' && 'utxos' in a && 'utxos' in b) {
    if (original.wallet.network !== 'regtest') reject('uncertified Bitcoin network');
    if (a.sweepAll || b.sweepAll || a.changeAmount === undefined || b.changeAmount === undefined)
      reject('replacement requires exact withdrawal principals and hot change');
    if (!same(a.outputs, b.outputs)) reject('payout outputs changed');
    if (a.outputs.some((o) => o.address === original.wallet.address))
      reject('hot change must not masquerade as a payout');
    const inputs = (r: typeof a) =>
      [...r.utxos].sort((x, y) => `${x.txid}:${x.vout}`.localeCompare(`${y.txid}:${y.vout}`));
    if (!same(inputs(a), inputs(b)))
      reject('replacement must use exactly the original owned inputs');
    const keys = a.utxos.map((u) => `utxo:${u.txid}:${u.vout}`).sort();
    if (new Set(keys).size !== keys.length) reject('duplicate Bitcoin input');
    const total = a.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n),
      principal = a.outputs.reduce((sum, o) => sum + BigInt(o.amount), 0n);
    const oldFee = total - principal - BigInt(a.changeAmount),
      fee = total - principal - BigInt(b.changeAmount);
    if (
      oldFee <= 0n ||
      fee <= oldFee ||
      fee > 10000n ||
      b.satsPerVbyte <= a.satsPerVbyte ||
      b.satsPerVbyte > 100
    )
      reject('replacement must increase absolute fee and rate within budget');
    if (BigInt(b.changeAmount) > 0n && BigInt(b.changeAmount) < 546n)
      reject('replacement change is dust');
    return {
      kind: 'bitcoin_same_inputs',
      originalRequestDigest: executionDigest(original),
      replacementRequestDigest: executionDigest(replacement),
      resourceKeys: keys,
      maximumFeeUnits: fee.toString(),
    };
  }
  return reject('unsupported replacement shape');
}

/** All retained predecessors must conflict, including attempts whose submission result was lost. */
export function withdrawalReplacementLineage(
  retained: readonly PaymentRequest[],
  candidate: PaymentRequest,
): ReplacementConflict {
  if (retained.length === 0 || retained.length > 8)
    reject('retained lineage must contain 1..8 attempts');
  const conflicts = retained.map((prior) => withdrawalReplacementConflict(prior, candidate));
  if (
    conflicts.some(
      (c) => c.kind !== conflicts[0].kind || !same(c.resourceKeys, conflicts[0].resourceKeys),
    )
  )
    reject('retained attempts do not share the original conflicting resource');
  return conflicts[conflicts.length - 1];
}
