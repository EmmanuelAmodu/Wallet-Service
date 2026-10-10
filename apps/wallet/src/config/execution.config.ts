import { registerAs } from '@nestjs/config';
import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { integerSetting, required } from '../../../../packages/shared/src/config.js';

export interface ExecutionSettings {
  enabled: boolean;
  authorityPrivateKey?: KeyObject;
  signerPublicKey?: KeyObject;
  pollIntervalMs: number;
}
export const executionConfig = registerAs('custodyExecution', (): ExecutionSettings => {
  const flag = process.env.ENABLE_NATIVE_SWEEPS ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('Invalid configuration: ENABLE_NATIVE_SWEEPS');
  const enabled = flag === 'true';
  const pollIntervalMs = integerSetting('EXECUTION_RECONCILIATION_MS', 30000, 100, 86400000);
  if (!enabled) return { enabled, pollIntervalMs };
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
  return { enabled, authorityPrivateKey, signerPublicKey, pollIntervalMs };
});
