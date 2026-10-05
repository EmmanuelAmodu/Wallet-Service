import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export interface AccessTokenSettings {
  issuer: string;
  audience: string;
  resetEpoch: string;
}

const claimsSchema = z
  .object({
    iss: z.string(),
    aud: z.string(),
    sub: z.uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.uuid(),
    resetEpoch: z.string().min(1).max(128),
  })
  .strict();

function checkRsa(pem: string, privateKey: boolean) {
  const header = privateKey ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  if (!pem.startsWith(header)) throw new Error('Expected an RSA PKCS8/SPKI token key');
  const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
    throw new Error('Token keys require RSA with at least 2048 bits');
}

export class AccessTokenIssuer {
  private readonly key: ReturnType<typeof importPKCS8>;

  constructor(
    pem: string,
    private readonly settings: AccessTokenSettings,
    readonly lifetimeSeconds = 900,
  ) {
    checkRsa(pem, true);
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 3600)
      throw new Error('Invalid access token lifetime');
    this.key = importPKCS8(pem, 'RS256');
  }

  async ready() {
    await this.key;
  }

  async issue(userId: string) {
    z.uuid().parse(userId);
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ resetEpoch: this.settings.resetEpoch })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + this.lifetimeSeconds)
      .sign(await this.key);
    return { accessToken, tokenType: 'Bearer' as const, expiresIn: this.lifetimeSeconds };
  }
}

export class AccessTokenVerifier {
  private readonly key: ReturnType<typeof importSPKI>;

  constructor(
    pem: string,
    private readonly settings: AccessTokenSettings,
  ) {
    checkRsa(pem, false);
    this.key = importSPKI(pem, 'RS256');
  }

  async ready() {
    await this.key;
  }

  async verify(token: string) {
    if (!token || token.length > 8192) throw new Error('Invalid access token');
    const result = await jwtVerify(token, await this.key, {
      algorithms: ['RS256'],
      typ: 'JWT',
      issuer: this.settings.issuer,
      audience: this.settings.audience,
      requiredClaims: ['sub', 'iat', 'exp', 'jti', 'resetEpoch'],
      maxTokenAge: 3600,
      clockTolerance: 5,
    });
    const claims = claimsSchema.parse(result.payload);
    if (
      claims.resetEpoch !== this.settings.resetEpoch ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 3600 ||
      claims.iat > Math.floor(Date.now() / 1000) + 5
    )
      throw new Error('Invalid access token claims');
    return { userId: claims.sub, tokenId: claims.jti };
  }
}
