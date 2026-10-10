import { generateKeyPairSync } from 'node:crypto';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function executionKeyPaths(directory = 'secrets') {
  return {
    authorityPrivate: resolve(directory, 'execution-authority-private.pem'),
    authorityPublic: resolve(directory, 'execution-authority-public.pem'),
    signerPrivate: resolve(directory, 'execution-signer-private.pem'),
    signerPublic: resolve(directory, 'execution-signer-public.pem'),
  };
}

/** Create separate spending authority and result attestation keys without rotation. */
export async function setupExecutionPolicy(directory = 'secrets') {
  const paths = executionKeyPaths(directory);
  for (const path of Object.values(paths)) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error('Execution policy key already exists; refusing to replace any key');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const options = {
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const },
  };
  const authority = generateKeyPairSync('ed25519', options);
  const signer = generateKeyPairSync('ed25519', options);
  const files = [
    [paths.authorityPrivate, authority.privateKey],
    [paths.authorityPublic, authority.publicKey],
    [paths.signerPrivate, signer.privateKey],
    [paths.signerPublic, signer.publicKey],
  ];
  const created: string[] = [];
  try {
    for (const [path, key] of files) {
      await writeFile(path, key, { flag: 'wx', mode: 0o600 });
      created.push(path);
    }
  } catch (error) {
    // Leave existing keys intact if another setup wins a race or writing fails.
    for (const path of created) await unlink(path);
    throw error;
  }
  return paths;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args.length && (args.length !== 2 || args[0] !== '--directory' || !args[1]))
      throw new Error('Usage: setup:execution-policy [--directory PATH]');
    await setupExecutionPolicy(args[1]);
    console.log('Created two independent execution policy key pairs with owner-only permissions.');
  };
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
