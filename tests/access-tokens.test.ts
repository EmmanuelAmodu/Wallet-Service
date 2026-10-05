import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import {
  AccessTokenIssuer,
  AccessTokenVerifier,
} from '../packages/shared/src/security/access-tokens.js';
import {
  tokenIdentitySettings,
  tokenPemSetting,
} from '../packages/shared/src/security/token-config.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const settings = { issuer: 'test-user', audience: 'test-wallet', resetEpoch: 'token-test-epoch' };

test('User access tokens verify offline using only the public key and carry bounded identity', async () => {
  const issuer = new AccessTokenIssuer(keys.privateKey, settings, 900);
  const verifier = new AccessTokenVerifier(keys.publicKey, settings);
  const userId = randomUUID();
  const first = await issuer.issue(userId);
  const second = await issuer.issue(userId);
  assert.equal(first.tokenType, 'Bearer');
  assert.equal(first.expiresIn, 900);
  const identity = await verifier.verify(first.accessToken);
  assert.equal(identity.userId, userId);
  assert.notEqual(identity.tokenId, (await verifier.verify(second.accessToken)).tokenId);
  assert.equal(first.accessToken.includes(userId), false);
  assert.throws(() => new AccessTokenVerifier(keys.privateKey, settings), /PKCS8\/SPKI/);
  assert.throws(() => new AccessTokenIssuer(keys.privateKey, settings, 3601), /lifetime/);
});

test('Wallet rejects wrong algorithm, signature, issuer, audience, epoch and invalid claim lifetimes', async () => {
  const verifier = new AccessTokenVerifier(keys.publicKey, settings);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: settings.issuer,
    aud: settings.audience,
    resetEpoch: settings.resetEpoch,
    sub: randomUUID(),
    jti: randomUUID(),
    iat: now,
    exp: now + 900,
  };
  const privateKey = await importPKCS8(keys.privateKey, 'RS256');
  const sign = (claims: Record<string, unknown>, typ = 'JWT') =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ }).sign(privateKey);
  for (const patch of [
    { iss: 'another-user-service' },
    { aud: 'another-api' },
    { resetEpoch: 'old-epoch' },
    { sub: 'another-customer' },
    { jti: 'invalid' },
    { iat: now - 100, exp: now - 20 },
    { iat: now + 60, exp: now + 900 },
    { exp: now + 3601 },
    { exp: now },
    { role: 'admin' },
  ])
    await assert.rejects(verifier.verify(await sign({ ...payload, ...patch })));
  const withoutExpiry: Record<string, unknown> = { ...payload };
  delete withoutExpiry.exp;
  await assert.rejects(verifier.verify(await sign(withoutExpiry)));
  await assert.rejects(verifier.verify(await sign(payload, 'service-token')));
  const symmetric = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(keys.publicKey));
  await assert.rejects(verifier.verify(symmetric));
  const signed = await sign(payload);
  const [header, body, signature] = signed.split('.');
  await assert.rejects(verifier.verify(`${header}.${body}.${signature.slice(0, -8)}aaaaaaaa`));
  await assert.rejects(verifier.verify(`${header}.${body}.`));
  await assert.rejects(verifier.verify('x'.repeat(8193)));
  const wrongKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await assert.rejects(new AccessTokenVerifier(wrongKeys.publicKey, settings).verify(signed));
});

test('Authentication key configuration rejects ambiguous sources and requires keys in production', () => {
  assert.equal(tokenPemSetting('AUTH_TOKEN_PRIVATE_KEY', {}), undefined);
  assert.throws(
    () => tokenPemSetting('AUTH_TOKEN_PRIVATE_KEY', { NODE_ENV: 'production' }),
    /Missing configuration/,
  );
  assert.throws(
    () =>
      tokenPemSetting('AUTH_TOKEN_PUBLIC_KEY', {
        AUTH_TOKEN_PUBLIC_KEY: keys.publicKey,
        AUTH_TOKEN_PUBLIC_KEY_FILE: 'another-key.pem',
      }),
    /Configure only/,
  );
  assert.equal(
    tokenPemSetting('AUTH_TOKEN_PUBLIC_KEY', {
      AUTH_TOKEN_PUBLIC_KEY: keys.publicKey.replaceAll('\n', '\\n'),
    }),
    keys.publicKey.trim(),
  );
  assert.throws(() => tokenIdentitySettings({ AUTH_TOKEN_ISSUER: ' ' }));
});
