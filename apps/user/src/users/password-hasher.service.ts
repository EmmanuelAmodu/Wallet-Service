import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { userConfig, UserConfig } from '../config/user.config.js';

const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 144 * 1024 * 1024;
const KEY_BYTES = 64;
const SALT_BYTES = 32;
const hashPattern = /^scrypt\$131072\$8\$1\$([0-9a-f]{64})\$([0-9a-f]{128})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

@Injectable()
export class PasswordHasher {
  private active = 0;

  constructor(
    @Inject(userConfig.KEY) private readonly config: Pick<UserConfig, 'hashConcurrency'>,
  ) {}

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    // Reject before allocating scrypt memory; there is deliberately no unbounded waiting queue.
    if (this.active >= this.config.hashConcurrency)
      throw new HttpException(
        'Authentication capacity exceeded; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }

  hash(password: string): Promise<string> {
    return this.bounded(async () => {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt);
      return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
    });
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const match = hashPattern.exec(encodedHash);
    if (!match) return false;
    return this.bounded(async () => {
      const actual = await derive(password, Buffer.from(match[1], 'hex'));
      return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
    });
  }
}
