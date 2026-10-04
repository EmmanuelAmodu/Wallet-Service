import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const resetControlKeys = new Set([
  'RESET_EPOCH',
  'RESET_IN_PROGRESS',
  'RESET_PREVIOUS_QUEUE_PREFIX',
  'RESET_PREVIOUS_SUBSCRIPTION',
]);

function canonicalEnvironmentPath(envPath: string) {
  const path = resolve(envPath);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

export function resetEnvironmentPath(environment: NodeJS.ProcessEnv = process.env) {
  return canonicalEnvironmentPath(environment.RESET_ENV_FILE || '.env');
}

export function dotenvAssignmentSpans(content: string) {
  const lines = content.split(/\r?\n/);
  const spans: { key: string; startLine: number; endLine: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[index]);
    if (!assignment) continue;
    const [, key, value] = assignment;
    const startLine = index;
    const quote = value[0];
    if (['"', "'", '`'].includes(quote) && !value.slice(1).includes(quote)) {
      const closingLine = lines.findIndex(
        (line, following) => following > index && line.includes(quote),
      );
      // Node's dotenv parser treats an unterminated quote as an ordinary single-line value.
      if (closingLine !== -1) index = closingLine;
    }
    spans.push({ key, startLine, endLine: index });
  }
  return spans;
}

function rejectDuplicateResetControls(content: string) {
  const seen = new Set<string>();
  for (const { key } of dotenvAssignmentSpans(content)) {
    if (!resetControlKeys.has(key)) continue;
    if (seen.has(key)) throw new Error(`Duplicate ${key} in the reset environment file`);
    seen.add(key);
  }
}

function readEnvironment(envPath: string, explicitlyConfigured: boolean) {
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !explicitlyConfigured) return {};
    throw new Error(`Cannot read the durable reset environment file at ${envPath}`, {
      cause: error,
    });
  }
  rejectDuplicateResetControls(content);
  return Object.fromEntries(
    Object.entries(parseEnv(content)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function readResetEnvironment(envPath = resetEnvironmentPath()): Record<string, string> {
  const path = canonicalEnvironmentPath(envPath);
  return readEnvironment(
    path,
    Boolean(process.env.RESET_ENV_FILE) || path !== canonicalEnvironmentPath('.env'),
  );
}

export function assertResetReady(
  environment: NodeJS.ProcessEnv = process.env,
  envPath = resetEnvironmentPath(environment),
) {
  const path = canonicalEnvironmentPath(envPath);
  let hasLock = true;
  try {
    lstatSync(`${path}.reset.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot verify whether a development reset lock exists', { cause: error });
    hasLock = false;
  }
  if (hasLock)
    throw new Error(
      'Development reset lock exists; services must remain stopped until it is resolved',
    );
  const durable = readEnvironment(
    path,
    Boolean(environment.RESET_ENV_FILE) || path !== canonicalEnvironmentPath('.env'),
  );
  if (durable.RESET_IN_PROGRESS || environment.RESET_IN_PROGRESS)
    throw new Error(
      'Development reset is in progress; services must remain stopped until resume completes',
    );
  if (
    durable.RESET_EPOCH !== undefined &&
    environment.RESET_EPOCH !== undefined &&
    durable.RESET_EPOCH !== environment.RESET_EPOCH
  )
    throw new Error(
      'RESET_EPOCH differs from durable reset state; reload configuration before starting',
    );
}

export async function acquireDevelopmentResetLock(envPath: string) {
  const lockPath = `${canonicalEnvironmentPath(envPath)}.reset.lock`;
  const owner = { token: randomUUID(), pid: process.pid };
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Development reset lock exists at ${lockPath}. Confirm no reset process is running, remove only an orphan lock, then resume the reset. Never clear RESET_IN_PROGRESS manually.`,
        { cause: error },
      );
    throw error;
  }
  const identity = await handle.stat();
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    try {
      const current = await lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AggregateError([error, cleanupError], 'Could not write or clean up reset lock', {
          cause: cleanupError,
        });
    }
    throw error;
  } finally {
    await handle.close();
  }
  let released = false;

  async function assertOwned() {
    try {
      const current = await lstat(lockPath);
      const record: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (
        released ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        !record ||
        typeof record !== 'object' ||
        !('token' in record) ||
        !('pid' in record) ||
        record.token !== owner.token ||
        record.pid !== owner.pid
      )
        throw new Error('Reset lock owner changed');
    } catch (error) {
      throw new Error(`Development reset lock ownership lost at ${lockPath}`, { cause: error });
    }
  }

  return {
    assertOwned,
    async release() {
      if (released) return;
      await assertOwned();
      await unlink(lockPath);
      released = true;
    },
  };
}
