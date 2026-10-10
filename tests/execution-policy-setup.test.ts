import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executionKeyPaths, setupExecutionPolicy } from '../scripts/setup-execution-policy.js';

test('execution setup creates independent matching Ed25519 key pairs with owner-only files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-execution-keys-'));
  try {
    const paths = await setupExecutionPolicy(join(directory, 'keys'));
    const contents = await Promise.all(Object.values(paths).map((path) => readFile(path)));
    assert.equal(createPrivateKey(contents[0]).asymmetricKeyType, 'ed25519');
    assert.equal(createPrivateKey(contents[2]).asymmetricKeyType, 'ed25519');
    assert.notDeepEqual(contents[0], contents[2]);
    assert.notDeepEqual(contents[1], contents[3]);
    const message = Buffer.from('execution setup test');
    assert(verify(null, message, createPublicKey(contents[1]), sign(null, message, contents[0])));
    assert(verify(null, message, createPublicKey(contents[3]), sign(null, message, contents[2])));
    assert(!verify(null, message, createPublicKey(contents[3]), sign(null, message, contents[0])));
    for (const path of Object.values(paths)) assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(setupExecutionPolicy(join(directory, 'keys')), /refusing/);
    assert.deepEqual(
      await Promise.all(Object.values(paths).map((path) => readFile(path))),
      contents,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('execution setup refuses partial key sets before creating or replacing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-partial-execution-keys-'));
  try {
    const paths = executionKeyPaths(directory);
    await writeFile(paths.signerPublic, 'existing key', { mode: 0o600 });
    await assert.rejects(setupExecutionPolicy(directory), /refusing/);
    assert.equal(await readFile(paths.signerPublic, 'utf8'), 'existing key');
    assert.deepEqual(await readdir(directory), ['execution-signer-public.pem']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent execution setup has one owner and leaves a complete matched key set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-concurrent-execution-keys-'));
  try {
    const results = await Promise.allSettled([
      setupExecutionPolicy(directory),
      setupExecutionPolicy(directory),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await readdir(directory)).length, 4);
    const paths = executionKeyPaths(directory);
    assert.deepEqual(
      createPublicKey(await readFile(paths.authorityPrivate)).export({
        type: 'spki',
        format: 'pem',
      }),
      await readFile(paths.authorityPublic, 'utf8'),
    );
    assert.deepEqual(
      createPublicKey(await readFile(paths.signerPrivate)).export({ type: 'spki', format: 'pem' }),
      await readFile(paths.signerPublic, 'utf8'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh local setup provisions policy keys while a repeat leaves keys, seed and environment unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-fresh-local-'));
  try {
    await writeFile(join(directory, '.env.example'), await readFile(resolve('.env.example')));
    const args = ['--import', import.meta.resolve('tsx'), resolve('scripts/setup-local.ts')];
    const first = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const paths = executionKeyPaths(join(directory, 'secrets'));
    const watched = [
      ...Object.values(paths),
      join(directory, 'secrets/local.mnemonic'),
      join(directory, '.env'),
    ];
    const before = await Promise.all(watched.map((path) => readFile(path)));
    const environment = await readFile(join(directory, '.env'), 'utf8');
    assert(environment.includes('ENABLE_NATIVE_SWEEPS=false'));
    assert(environment.includes('ALLOW_BROADCAST=false'));
    for (const path of watched) assert.equal((await stat(path)).mode & 0o777, 0o600);
    const second = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing/);
    assert.deepEqual(await Promise.all(watched.map((path) => readFile(path))), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh local setup refuses existing execution keys before generating a new seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-existing-policy-'));
  try {
    await writeFile(join(directory, '.env.example'), await readFile(resolve('.env.example')));
    await mkdir(join(directory, 'secrets'));
    await writeFile(executionKeyPaths(join(directory, 'secrets')).authorityPublic, 'existing');
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), resolve('scripts/setup-local.ts')],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing/);
    assert.deepEqual(await readdir(join(directory, 'secrets')), ['execution-authority-public.pem']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
