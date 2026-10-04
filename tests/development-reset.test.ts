import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireDevelopmentResetLock,
  assertResetReady,
  dotenvAssignmentSpans,
  readResetEnvironment,
  resetEnvironmentPath,
} from '../packages/shared/src/development-reset.js';

async function environmentFile(t: TestContext, content?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wallet-reset-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  if (content !== undefined) await writeFile(path, content);
  return { directory, path };
}

test('durable reset state overrides an empty inherited startup fence', async (t) => {
  const { path } = await environmentFile(t, 'RESET_IN_PROGRESS=epoch-new\nRESET_EPOCH=epoch-new\n');
  assert.throws(
    () => assertResetReady({ RESET_IN_PROGRESS: '', RESET_EPOCH: 'epoch-old' }, path),
    /reset is in progress/,
  );
  assert.throws(
    () => assertResetReady({ RESET_EPOCH: 'epoch-new', RESET_IN_PROGRESS: 'epoch-new' }, path),
    /reset is in progress/,
  );
});

test('completed reset rejects inherited old epochs without replacing them', async (t) => {
  const { path } = await environmentFile(t, 'RESET_IN_PROGRESS=\nRESET_EPOCH=epoch-new\n');
  const environment = { RESET_IN_PROGRESS: '', RESET_EPOCH: 'epoch-old' };
  assert.throws(() => assertResetReady(environment, path), /differs from durable reset state/);
  assert.equal(environment.RESET_EPOCH, 'epoch-old');
  assert.doesNotThrow(() => assertResetReady({ RESET_EPOCH: 'epoch-new' }, path));
  assert.doesNotThrow(() => assertResetReady({}, path));
  assert.throws(
    () => assertResetReady({ RESET_EPOCH: 'epoch-new', RESET_IN_PROGRESS: 'epoch-new' }, path),
    /reset is in progress/,
  );
});

test('configured reset state paths fail closed when missing', async (t) => {
  const { path } = await environmentFile(t);
  assert.equal(resetEnvironmentPath({ RESET_ENV_FILE: path }), path);
  assert.equal(resetEnvironmentPath({}), resolve('.env'));
  assert.throws(() => readResetEnvironment(path), /Cannot read the durable reset/);
  assert.throws(
    () => assertResetReady({ RESET_ENV_FILE: path, RESET_EPOCH: 'epoch' }),
    /Cannot read the durable reset/,
  );
});

test('missing default environment remains supported for environment-only deployments', async (t) => {
  const { directory } = await environmentFile(t);
  const previousDirectory = process.cwd();
  const previousPath = process.env.RESET_ENV_FILE;
  try {
    process.chdir(directory);
    delete process.env.RESET_ENV_FILE;
    assert.deepEqual(readResetEnvironment(), {});
    assert.doesNotThrow(() => assertResetReady({ RESET_EPOCH: 'epoch' }));
    assert.throws(
      () => assertResetReady({ RESET_ENV_FILE: '.env', RESET_EPOCH: 'epoch' }),
      /Cannot read the durable reset/,
    );
  } finally {
    process.chdir(previousDirectory);
    if (previousPath === undefined) delete process.env.RESET_ENV_FILE;
    else process.env.RESET_ENV_FILE = previousPath;
  }
});

test('reset controls reject duplicate assignments with dotenv spacing and export syntax', async (t) => {
  const { path } = await environmentFile(t, 'export RESET_EPOCH = old\n RESET_EPOCH=new\n');
  assert.throws(() => readResetEnvironment(path), /Duplicate RESET_EPOCH/);
  await writeFile(path, 'RESET_IN_PROGRESS=\nexport RESET_IN_PROGRESS=epoch\n');
  assert.throws(() => assertResetReady({}, path), /Duplicate RESET_IN_PROGRESS/);
  await writeFile(path, 'OTHER="unterminated\nRESET_IN_PROGRESS=epoch\nRESET_IN_PROGRESS=\n');
  assert.throws(() => readResetEnvironment(path), /Duplicate RESET_IN_PROGRESS/);
  await writeFile(
    path,
    'OTHER="multiline\nRESET_EPOCH=inside quoted value\n"\nRESET_EPOCH=epoch\n',
  );
  assert.equal(readResetEnvironment(path).RESET_EPOCH, 'epoch');
});

test('dotenv spans describe real assignments and include their complete quoted values', () => {
  const content = [
    'OTHER="header',
    'RESET_IN_PROGRESS=fake',
    'footer"',
    'export RESET_IN_PROGRESS = "old',
    'value"',
    'RESET_EPOCH=epoch',
    '',
  ].join('\n');
  assert.deepEqual(dotenvAssignmentSpans(content), [
    { key: 'OTHER', startLine: 0, endLine: 2 },
    { key: 'RESET_IN_PROGRESS', startLine: 3, endLine: 4 },
    { key: 'RESET_EPOCH', startLine: 5, endLine: 5 },
  ]);
});

test('exclusive reset lock permits one concurrent owner and can be released safely', async (t) => {
  const { path } = await environmentFile(t, 'RESET_EPOCH=epoch\n');
  const attempts = await Promise.allSettled([
    acquireDevelopmentResetLock(path),
    acquireDevelopmentResetLock(path),
  ]);
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
  const rejected = attempts.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /Confirm no reset process is running/);
  const first = fulfilled[0].value;
  const record = JSON.parse(await readFile(`${path}.reset.lock`, 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(typeof record.token, 'string');
  await first.assertOwned();
  await first.release();
  const next = await acquireDevelopmentResetLock(path);
  await first.release();
  await next.assertOwned();
  await next.release();
});

test('reset lock does not steal orphan locks automatically', async (t) => {
  const { path } = await environmentFile(t);
  const orphan = JSON.stringify({ token: 'orphan', pid: 999999999 });
  await writeFile(`${path}.reset.lock`, orphan);
  await assert.rejects(acquireDevelopmentResetLock(path), /remove only an orphan lock/);
  assert.equal(await readFile(`${path}.reset.lock`, 'utf8'), orphan);
});

test('environment symlink aliases share durable state and the same exclusive lock', async (t) => {
  const { directory, path } = await environmentFile(t, 'RESET_EPOCH=epoch\n');
  const alias = join(directory, '.env-alias');
  await symlink(path, alias);
  assert.equal(resetEnvironmentPath({ RESET_ENV_FILE: alias }), path);
  assert.deepEqual(readResetEnvironment(alias), readResetEnvironment(path));
  const lock = await acquireDevelopmentResetLock(path);
  await assert.rejects(acquireDevelopmentResetLock(alias), /reset lock exists/);
  await lock.release();
});

test('startup stays fenced during lock-only preparation and completion windows', async (t) => {
  const { path } = await environmentFile(t, 'RESET_IN_PROGRESS=\nRESET_EPOCH=epoch\n');
  const lock = await acquireDevelopmentResetLock(path);
  assert.throws(() => assertResetReady({ RESET_EPOCH: 'epoch' }, path), /reset lock exists/);
  await lock.release();
  assert.doesNotThrow(() => assertResetReady({ RESET_EPOCH: 'epoch' }, path));
});

test('reset lock release refuses to delete a changed owner', async (t) => {
  const { path } = await environmentFile(t);
  const lock = await acquireDevelopmentResetLock(path);
  const replacement = JSON.stringify({ token: 'another-owner', pid: process.pid });
  await writeFile(`${path}.reset.lock`, replacement);
  await assert.rejects(lock.assertOwned(), /ownership lost/);
  await assert.rejects(lock.release(), /ownership lost/);
  assert.equal(await readFile(`${path}.reset.lock`, 'utf8'), replacement);
});
