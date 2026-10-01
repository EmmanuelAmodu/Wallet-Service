import { initWasm } from '@trustwallet/wallet-core';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
async function setup() {
  for (const path of ['.env', 'secrets/local.mnemonic']) {
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
    const template = await readFile('.env.example', 'utf8');
    await writeFile(
      '.env',
      template
        .replace('REPLACE_WITH_RANDOM_32_BYTE_TOKEN', randomBytes(32).toString('hex'))
        .replace('REPLACE_WITH_A_DIFFERENT_RANDOM_TOKEN', randomBytes(32).toString('hex')),
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
