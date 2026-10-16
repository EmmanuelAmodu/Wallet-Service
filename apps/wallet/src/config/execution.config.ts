import { registerAs } from '@nestjs/config';
import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export interface ExecutionSettings {
  enabled: boolean;
  tokensEnabled?: boolean;
  sweepsEnabled?: boolean;
  withdrawalsEnabled?: boolean;
  bitcoinBatchesEnabled?: boolean;
  authorityPrivateKey?: KeyObject;
  signerPublicKey?: KeyObject;
  pollIntervalMs: number;
}
export const executionConfig = registerAs('custodyExecution', (): ExecutionSettings => {
  const flag = process.env.ENABLE_NATIVE_SWEEPS ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('Invalid configuration: ENABLE_NATIVE_SWEEPS');
  const withdrawalFlag = process.env.ENABLE_NATIVE_WITHDRAWALS ?? 'false';
  if (!['true', 'false'].includes(withdrawalFlag))
    throw new Error('Invalid configuration: ENABLE_NATIVE_WITHDRAWALS');
  const tokenFlag = process.env.ENABLE_TOKEN_EXECUTION ?? 'false';
  if (!['true', 'false'].includes(tokenFlag))
    throw new Error('Invalid configuration: ENABLE_TOKEN_EXECUTION');
  const tokensEnabled = tokenFlag === 'true';
  const withdrawalsEnabled = withdrawalFlag === 'true';
  const batchFlag = process.env.ENABLE_BITCOIN_BATCH_WITHDRAWALS ?? 'false';
  if (!['true', 'false'].includes(batchFlag))
    throw new Error('Invalid configuration: ENABLE_BITCOIN_BATCH_WITHDRAWALS');
  if (batchFlag === 'true' && !withdrawalsEnabled)
    throw new Error('Bitcoin batches require native withdrawals');
  const bitcoinBatchesEnabled = batchFlag === 'true';
  const sweepsEnabled = flag === 'true';
  const enabled = sweepsEnabled || withdrawalsEnabled || tokensEnabled;
  const pollIntervalMs = integerSetting('EXECUTION_RECONCILIATION_MS', 30000, 100, 86400000);
  if (!enabled)
    return { enabled, sweepsEnabled, withdrawalsEnabled, tokensEnabled, pollIntervalMs };
  const path = required('EXECUTION_AUTHORITY_PRIVATE_KEY_FILE');
  const stat = statSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('Execution authority private key must be owner-only');
  const authorityPrivateKey = createPrivateKey(readFileSync(path));
  const encoded = readFileSync(required('EXECUTION_SIGNER_PUBLIC_KEY_FILE'));
  if (!encoded.toString('utf8').trimStart().startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Execution signer key must be public-only PEM');
  const signerPublicKey = createPublicKey(encoded);
  if (
    authorityPrivateKey.asymmetricKeyType !== 'ed25519' ||
    signerPublicKey.asymmetricKeyType !== 'ed25519'
  )
    throw new Error('Execution policy keys must be Ed25519');
  if (
    createPublicKey(authorityPrivateKey).export({ type: 'spki', format: 'pem' }) ===
    signerPublicKey.export({ type: 'spki', format: 'pem' })
  )
    throw new Error('Execution authority and Signer attestation need independent keys');
  return {
    enabled,
    tokensEnabled,
    sweepsEnabled,
    withdrawalsEnabled,
    bitcoinBatchesEnabled,
    authorityPrivateKey,
    signerPublicKey,
    pollIntervalMs,
  };
});
