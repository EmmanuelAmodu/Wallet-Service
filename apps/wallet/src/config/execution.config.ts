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
  const enabled = process.env.ENABLE_NATIVE_SWEEPS === 'true';
  const pollIntervalMs = integerSetting('EXECUTION_RECONCILIATION_MS', 30000, 100, 86400000);
  if (!enabled) return { enabled, pollIntervalMs };
  const path = required('EXECUTION_AUTH_PRIVATE_KEY_FILE');
  if (statSync(path).mode & 0o077) throw new Error('Execution authority private key must be owner-only');
  const authorityPrivateKey = createPrivateKey(readFileSync(path));
  const signerPublicKey = createPublicKey(readFileSync(required('EXECUTION_SIGNER_PUBLIC_KEY_FILE')));
  if (authorityPrivateKey.asymmetricKeyType !== 'ed25519' || signerPublicKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Execution policy keys must be Ed25519');
  if (createPublicKey(authorityPrivateKey).export({type:'spki',format:'pem'}) === signerPublicKey.export({type:'spki',format:'pem'}))
    throw new Error('Execution authority and Signer attestation need independent keys');
  return { enabled, authorityPrivateKey, signerPublicKey, pollIntervalMs };
});
