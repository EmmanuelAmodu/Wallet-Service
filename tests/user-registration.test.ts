import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ExecutionContext, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UserPrismaService } from '../apps/user/src/prisma/prisma.service.js';
import { PasswordHasher } from '../apps/user/src/users/password-hasher.service.js';
import { UsersService } from '../apps/user/src/users/users.service.js';
import { UsersController } from '../apps/user/src/users/users.controller.js';
import { RegistrationThrottleGuard } from '../apps/user/src/users/registration-throttle.guard.js';
import { registerUserSchema } from '../apps/user/src/users/dto/register-user.dto.js';
import { userConfig } from '../apps/user/src/config/user.config.js';
import { UserErrorsFilter } from '../apps/user/src/users/user-errors.filter.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';

const enabled = !!process.env.TEST_USER_DATABASE_URL;
const db = enabled
  ? new UserPrismaService({ databaseUrl: process.env.TEST_USER_DATABASE_URL! })
  : undefined;
const passwords = new PasswordHasher({ hashConcurrency: 2 });
const auth = new MessageAuth('q'.repeat(64), `users-test-${randomUUID()}`);
const config = {
  domainId: `users-domain-${randomUUID()}`,
  hashConcurrency: 2,
  registrationWindowMs: 60000,
  registrationIpLimit: 100,
  registrationGlobalLimit: 100,
};
const users = db ? new UsersService(db, passwords, config, auth) : undefined;
const emailPrefix = `users-${randomUUID()}`;
const password = '  A long registration password 🔑  ';

before(async () => {
  if (!enabled) return;
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      'prisma.user.config.ts',
    ],
    {
      env: { ...process.env, USER_DATABASE_URL: process.env.TEST_USER_DATABASE_URL! },
      stdio: 'pipe',
    },
  );
  assert.equal(result.status, 0, 'User test database migrations must deploy');
  await db!.$connect();
});

after(async () => {
  if (!db) return;
  await db.outbox.deleteMany({
    where: { payload: { path: ['domainId'], equals: config.domainId } },
  });
  await db.user.deleteMany({ where: { email: { startsWith: emailPrefix } } });
  await db.$disconnect();
});

test('Registration input normalizes email and preserves exact password Unicode and whitespace', () => {
  const body = registerUserSchema.parse({ email: '  Test@Example.COM  ', password });
  assert.equal(body.email, 'test@example.com');
  assert.equal(body.password, password);
  assert.ok(registerUserSchema.safeParse({ email: 'a@b.com', password: '🔑'.repeat(15) }).success);
  assert.ok(registerUserSchema.safeParse({ email: 'a@b.com', password: '🔑'.repeat(128) }).success);
  for (const invalid of [
    { email: 'invalid', password },
    { email: 'a@b.com', password: 'x'.repeat(14) },
    { email: 'a@b.com', password: '🔑'.repeat(129) },
    { email: 'a@b.com', password: 'x'.repeat(15) + '\uD800' },
    { email: 'a@b.com', password, userId: randomUUID() },
    { email: 'a@b.com', password, tenantId: 'another-owner' },
  ])
    assert.equal(registerUserSchema.safeParse(invalid).success, false);
});

test('Password hashing uses independent salts, bounded OWASP scrypt cost and exact-byte verification', async () => {
  const hasher = new PasswordHasher({ hashConcurrency: 2 });
  const [first, second] = await Promise.all([hasher.hash(password), hasher.hash(password)]);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$131072\$8\$1\$[a-f0-9]{64}\$[a-f0-9]{128}$/);
  assert.equal(await hasher.verify(password, first), true);
  assert.equal(await hasher.verify(password.trim(), first), false);
  assert.equal(await hasher.verify('another long password', first), false);
  assert.equal(await hasher.verify(password, first.replace('131072', '2147483648')), false);
});

test('Password hashing overload rejects work before allocation and releases capacity afterwards', async () => {
  const hasher = new PasswordHasher({ hashConcurrency: 1 });
  const running = hasher.hash(password);
  await assert.rejects(
    hasher.hash(password),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
  await running;
  assert.match(await hasher.hash(password), /^scrypt\$/);
});

function context(ip: string, headers: Record<string, string> = {}) {
  const responseHeaders: Record<string, unknown> = {};
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ ip, socket: { remoteAddress: ip }, headers }),
      getResponse: () => ({
        setHeader: (key: string, value: unknown) => {
          responseHeaders[key] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, responseHeaders };
}

test('Registration throttle limits direct clients and total attempts without trusting forwarded IPs', () => {
  const throttle = new RegistrationThrottleGuard({
    registrationWindowMs: 60000,
    registrationIpLimit: 1,
    registrationGlobalLimit: 2,
  });
  const first = context('127.0.0.1');
  assert.equal(throttle.canActivate(first.ctx), true);
  const spoofed = context('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' });
  assert.throws(
    () => throttle.canActivate(spoofed.ctx),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
  assert.equal(spoofed.responseHeaders['Retry-After'], 60);
  assert.equal(throttle.canActivate(context('127.0.0.2').ctx), true);
  assert.throws(
    () => throttle.canActivate(context('127.0.0.3').ctx),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
});

test(
  'Registration atomically persists hashed credentials and a secret-free Wallet provisioning event',
  { skip: !enabled },
  async () => {
    const result = await users!.register({ email: `  ${emailPrefix}-new@EXAMPLE.COM `, password });
    assert.equal(result.email, `${emailPrefix}-new@example.com`);
    assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'email', 'userId']);
    const stored = await db!.user.findUniqueOrThrow({ where: { id: result.userId } });
    assert.equal(stored.email, result.email);
    assert.notEqual(stored.password_hash, password);
    assert.equal(await passwords.verify(password, stored.password_hash), true);
    const outbox = await db!.outbox.findMany({
      where: { payload: { path: ['data', 'userId'], equals: result.userId } },
    });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].queue, QUEUES.wallet);
    const event = exchangeEventSchema.parse(outbox[0].payload);
    assert.equal(event.type, 'user.registered.v1');
    assert.equal(event.customerId, result.userId);
    assert.equal(event.aggregateId, result.userId);
    assert.equal(event.domainId, config.domainId);
    assert.equal(event.resetEpoch, auth.resetEpoch);
    assert.deepEqual(event.data, { userId: result.userId });
    assert.equal(JSON.stringify(outbox).includes(stored.email), false);
    assert.equal(JSON.stringify(outbox).includes(stored.password_hash), false);
    assert.equal(JSON.stringify(outbox).includes(password), false);
  },
);

test(
  'Normalized duplicate registration never changes the password or creates another financial event',
  { skip: !enabled },
  async () => {
    const email = `${emailPrefix}-duplicate@example.com`;
    const first = await users!.register({ email, password });
    const before = await db!.user.findUniqueOrThrow({ where: { id: first.userId } });
    await assert.rejects(
      users!.register({ email: ` ${email.toUpperCase()} `, password: 'different long password' }),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 409,
    );
    const after = await db!.user.findUniqueOrThrow({ where: { id: first.userId } });
    assert.equal(after.password_hash, before.password_hash);
    assert.equal(
      await db!.outbox.count({
        where: { payload: { path: ['data', 'userId'], equals: first.userId } },
      }),
      1,
    );
  },
);

test(
  'Concurrent registrations for one normalized email commit exactly one user and one event',
  { skip: !enabled },
  async () => {
    const email = `${emailPrefix}-race@example.com`;
    const results = await Promise.allSettled([
      users!.register({ email, password }),
      users!.register({ email: email.toUpperCase(), password: 'other concurrent password' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof HttpException);
    assert.equal(rejected.reason.getStatus(), 409);
    const stored = await db!.user.findMany({ where: { email } });
    assert.equal(stored.length, 1);
    assert.equal(
      await db!.outbox.count({
        where: { payload: { path: ['data', 'userId'], equals: stored[0].id } },
      }),
      1,
    );
  },
);

test(
  'A failed outbox write rolls back the registered user rather than stranding provisioning',
  { skip: !enabled },
  async () => {
    const faulty = new Proxy(db!, {
      get(target, key, receiver) {
        if (key === '$transaction')
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.$transaction(async (tx) =>
              work(
                new Proxy(tx, {
                  get(transaction, field, txReceiver) {
                    if (field === 'outbox')
                      return {
                        upsert: async () => {
                          throw new Error('Simulated outbox outage');
                        },
                      };
                    return Reflect.get(transaction, field, txReceiver);
                  },
                }),
              ),
            );
        return Reflect.get(target, key, receiver);
      },
    });
    const service = new UsersService(faulty, passwords, config, auth);
    const email = `${emailPrefix}-rollback@example.com`;
    await assert.rejects(service.register({ email, password }), /Simulated outbox outage/);
    assert.equal(await db!.user.count({ where: { email } }), 0);
  },
);

@Module({
  controllers: [UsersController],
  providers: [
    RegistrationThrottleGuard,
    { provide: UsersService, useValue: users },
    { provide: userConfig.KEY, useValue: config },
  ],
})
class RegistrationTestModule {}

test(
  'Nest registration route accepts valid public registration and rejects secrets, owner fields and malformed bodies',
  { skip: !enabled },
  async () => {
    const app = await NestFactory.create<NestExpressApplication>(RegistrationTestModule, {
      logger: false,
      bodyParser: false,
    });
    app.useBodyParser('json', { limit: '8kb' });
    app.useGlobalFilters(new UserErrorsFilter());
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    try {
      const response = await fetch(`${url}/v1/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${emailPrefix}-http@example.com`, password }),
      });
      assert.equal(response.status, 201);
      const registered = (await response.json()) as { userId: string };
      assert.equal('walletProvisioning' in registered, false);
      assert.match(registered.userId, /^[a-f0-9-]{36}$/);
      for (const body of [
        { email: 'invalid', password },
        { email: `${emailPrefix}-invalid@example.com`, password: 'short' },
        { email: `${emailPrefix}-invalid@example.com`, password, password_hash: 'sensitive' },
        { email: `${emailPrefix}-invalid@example.com`, password, tenantId: 'owner' },
      ]) {
        const invalid = await fetch(`${url}/v1/users/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.text()).includes(password), false);
      }
      const oversized = await fetch(`${url}/v1/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@b.com', password: 'x'.repeat(10000) }),
      });
      assert.equal(oversized.status, 413);
      const malformed = await fetch(`${url}/v1/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"email":"private@example.com","password":"private-secret",',
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.text()).includes('private-secret'), false);
      const fragment = await fetch(`${url}/v1/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'private-secret is invalid JSON',
      });
      assert.equal(fragment.status, 400);
      assert.equal((await fragment.text()).includes('private-secret'), false);
    } finally {
      await app.close();
    }
  },
);
