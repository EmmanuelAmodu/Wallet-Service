import { initWasm } from '@trustwallet/wallet-core';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

async function setup() {
  for (const path of [
    '.env',
    'secrets/local.mnemonic',
    'secrets/user-token-private.pem',
    'secrets/user-token-public.pem',
  ]) {
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error('Local configuration already exists; refusing to replace it');
  }
  const core = await initWasm();
  const wallet = core.HDWallet.create(256, '');
  try {
    await mkdir('secrets', { recursive: true, mode: 0o700 });
    await writeFile('secrets/local.mnemonic', wallet.mnemonic() + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await writeFile('secrets/user-token-private.pem', keys.privateKey, { mode: 0o600, flag: 'wx' });
    await writeFile('secrets/user-token-public.pem', keys.publicKey, { mode: 0o600, flag: 'wx' });
    const template = await readFile('.env.example', 'utf8');
    const resetEpoch = randomUUID();
    await writeFile(
      '.env',
      template
        .replace('REPLACE_WITH_RANDOM_32_BYTE_TOKEN', randomBytes(32).toString('hex'))
        .replace('REPLACE_WITH_A_DIFFERENT_RANDOM_TOKEN', randomBytes(32).toString('hex'))
        .replace('REPLACE_WITH_A_THIRD_RANDOM_TOKEN', randomBytes(32).toString('hex'))
        .replace('REPLACE_WITH_A_FOURTH_RANDOM_TOKEN', randomBytes(32).toString('hex'))
        .replace('REPLACE_WITH_RESET_EPOCH', resetEpoch)
        .replaceAll('REPLACE_WITH_EPOCH_SUFFIX', resetEpoch.slice(0, 8)),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Created .env and secrets/local.mnemonic. Keep the seed private and backed up; it is required to recover every derived wallet.',
    );
  } finally {
    wallet.delete();
  }
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
