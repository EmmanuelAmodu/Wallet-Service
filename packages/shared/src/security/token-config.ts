import { readFileSync } from 'node:fs';
import { z } from 'zod';

export function tokenIdentitySettings(environment: NodeJS.ProcessEnv = process.env) {
  const identifier = z.string().trim().min(1).max(128);
  return {
    issuer: identifier.parse(environment.AUTH_TOKEN_ISSUER ?? 'exchange-user'),
    audience: identifier.parse(environment.AUTH_TOKEN_AUDIENCE ?? 'exchange-wallet'),
  };
}

export function tokenPemSetting(name: string, environment: NodeJS.ProcessEnv = process.env) {
  const inline = environment[name];
  const file = environment[`${name}_FILE`];
  if (inline && file) throw new Error(`Configure only ${name} or ${name}_FILE`);
  if (!inline && !file) {
    if (environment.NODE_ENV === 'production') throw new Error(`Missing configuration: ${name}`);
    return undefined;
  }
  const value = (inline ?? readFileSync(file!, 'utf8')).replaceAll('\\n', '\n').trim();
  if (!value || value.length > 16384) throw new Error(`Invalid configuration: ${name}`);
  return value;
}
