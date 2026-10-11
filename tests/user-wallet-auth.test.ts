import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { ExecutionContext, HttpException, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UserPrismaService } from '../apps/user/src/prisma/prisma.service.js';
import { UsersService } from '../apps/user/src/users/users.service.js';
import { UsersController } from '../apps/user/src/users/users.controller.js';
import { PasswordHasher } from '../apps/user/src/users/password-hasher.service.js';
import { RegistrationThrottleGuard } from '../apps/user/src/users/registration-throttle.guard.js';
import { UserErrorsFilter } from '../apps/user/src/users/user-errors.filter.js';
import { AuthenticationController } from '../apps/user/src/auth/authentication.controller.js';
import { AuthenticationService } from '../apps/user/src/auth/authentication.service.js';
import { LoginThrottleGuard } from '../apps/user/src/auth/login-throttle.guard.js';
import { userConfig, UserConfig } from '../apps/user/src/config/user.config.js';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { NotFoundException } from '@nestjs/common';
import { WithdrawalsController } from '../apps/wallet/src/withdrawals/withdrawals.controller.js';
import {
  WithdrawalsService,
  WithdrawalRequest,
} from '../apps/wallet/src/withdrawals/withdrawals.service.js';
import { CustomerApiController } from '../apps/wallet/src/customers/customer-api.controller.js';
import { ExchangeCustomersController } from '../apps/wallet/src/customers/customers.controller.js';
import { ExchangeCustomersService } from '../apps/wallet/src/customers/customers.service.js';
import { ExchangeBackendGuard } from '../apps/wallet/src/customers/exchange-backend.guard.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { CustomerAuthGuard } from '../apps/wallet/src/auth/customer-auth.guard.js';
import { WalletAuthGuard } from '../apps/wallet/src/auth/wallet-auth.guard.js';
import { customerAuthConfig } from '../apps/wallet/src/config/customer-auth.config.js';
import { exchangeApiConfig } from '../apps/wallet/src/config/exchange-api.config.js';
import { walletConfig, WalletSettings } from '../apps/wallet/src/config/wallet.config.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { AccessTokenVerifier } from '../packages/shared/src/security/access-tokens.js';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { migrate } from '../scripts/migrate.js';
import { setupOpenApi } from '../apps/wallet/src/openapi.js';

const enabled = Boolean(
  process.env.TEST_USER_DATABASE_URL &&
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_LEDGER_DATABASE_URL,
);
const user = enabled
  ? new UserPrismaService({ databaseUrl: process.env.TEST_USER_DATABASE_URL! })
  : undefined;
const wallet = enabled
  ? new WalletPrismaService({ databaseUrl: process.env.TEST_DATABASE_URL! })
  : undefined;
const ledger = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const domainId = `user-auth-${randomUUID()}`;
const auth = new MessageAuth('q'.repeat(64), `auth-test-${randomUUID()}`);
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const tokenSettings = { issuer: 'auth-test-user', audience: 'auth-test-wallet' };
const registrationConfig = {
  domainId,
  hashConcurrency: 2,
  registrationWindowMs: 60000,
  registrationIpLimit: 100,
  registrationGlobalLimit: 100,
  loginWindowMs: 60000,
  loginIpLimit: 100,
  loginGlobalLimit: 100,
};
const walletSettings = {
  apiKey: 'w'.repeat(64),
  ethereumChainId: '11155111',
  solanaGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as WalletSettings;
const passwords = new PasswordHasher({ hashConcurrency: 2 });
const users = enabled ? new UsersService(user!, passwords, registrationConfig, auth) : undefined;
const login = enabled
  ? new AuthenticationService(
      user!,
      passwords,
      { ...tokenSettings, privateKey: keys.privateKey, lifetimeSeconds: 900 },
      auth,
    )
  : undefined;
const registry = enabled ? new ExchangeRegistryService(ledger!) : undefined;
const customers = enabled
  ? new ExchangeCustomersService(wallet!, { domainId, apiKey: 'e'.repeat(64) }, auth, {
      exchangeBalances: (d: string, c: string) => registry!.balances(d, c),
    } as LedgerClient)
  : undefined;
const messaging = enabled ? new ExchangeMessagingService(wallet!, auth, customers) : undefined;
const prefix = `auth-${randomUUID()}`;
const password = '  An exact login password 🔑  ';

before(async () => {
  if (!enabled) return;
  for (const [url, app] of [
    [process.env.TEST_USER_DATABASE_URL!, 'user'],
    [process.env.TEST_DATABASE_URL!, 'wallet'],
    [process.env.TEST_LEDGER_DATABASE_URL!, 'ledger'],
  ] as const)
    await migrate(url, app);
});
after(async () => {
  if (enabled) {
    const where = { payload: { path: ['domainId'], equals: domainId } };
    await Promise.all([
      user!.outbox.deleteMany({ where }),
      wallet!.outbox.deleteMany({ where }),
      ledger!.outbox.deleteMany({ where }),
    ]);
    await user!.user.deleteMany({ where: { email: { startsWith: prefix } } });
  }
  await Promise.all([user?.$disconnect(), wallet?.$disconnect(), ledger?.$disconnect()]);
});

@Module({
  controllers: [UsersController, AuthenticationController],
  providers: [
    RegistrationThrottleGuard,
    LoginThrottleGuard,
    { provide: UsersService, useValue: users },
    { provide: AuthenticationService, useValue: login },
    { provide: userConfig.KEY, useValue: registrationConfig },
  ],
})
class UserApiTestModule {}

const withdrawalApiRows = new Map<string, { id: string; customerId: string; state: string }>();
const withdrawalApiFixture = {
  request: async (customerId: string, _input: WithdrawalRequest) => {
    const row = { id: randomUUID(), customerId, state: 'reserving' };
    withdrawalApiRows.set(row.id, row);
    return row;
  },
  get: async (customerId: string, id: string) => {
    const row = withdrawalApiRows.get(id);
    if (row?.customerId !== customerId) throw new NotFoundException();
    return row;
  },
  list: async (customerId: string) => ({
    items: [...withdrawalApiRows.values()].filter((row) => row.customerId === customerId),
  }),
  cancel: async (customerId: string, id: string) => {
    const row = await withdrawalApiFixture.get(customerId, id);
    return { ...row, state: 'cancelling' };
  },
};

@Module({
  controllers: [CustomerApiController, ExchangeCustomersController, WithdrawalsController],
  providers: [
    { provide: WithdrawalsService, useValue: withdrawalApiFixture },
    { provide: APP_GUARD, useClass: WalletAuthGuard },
    CustomerAuthGuard,
    ExchangeBackendGuard,
    { provide: ExchangeCustomersService, useValue: customers },
    { provide: MessageAuth, useValue: auth },
    { provide: walletConfig.KEY, useValue: walletSettings },
    { provide: exchangeApiConfig.KEY, useValue: { domainId, apiKey: 'e'.repeat(64) } },
    {
      provide: customerAuthConfig.KEY,
      useValue: { ...tokenSettings, publicKey: keys.publicKey },
    },
  ],
})
class WalletApiTestModule {}

async function deliverIdentity(userId: string) {
  const delivery = await user!.outbox.findFirstOrThrow({
    where: { payload: { path: ['data', 'userId'], equals: userId } },
  });
  const signal = auth.open(
    auth.seal(exchangeEventSchema.parse(delivery.payload), delivery.id),
    delivery.id,
    'user.registered.v1',
  );
  await messaging!.handle(exchangeEventSchema.parse(signal));
  const command = await wallet!.outbox.findFirstOrThrow({
    where: { queue: QUEUES.ledger, payload: { path: ['customerId'], equals: userId } },
  });
  const event = exchangeEventSchema.parse(command.payload);
  await registry!.handle(event);
  const response = await ledger!.outbox.findFirstOrThrow({
    where: { payload: { path: ['causationId'], equals: event.eventId } },
  });
  await messaging!.handle(exchangeEventSchema.parse(response.payload));
}

test('Login throttle limits attempts independently of registration', () => {
  const guard = new LoginThrottleGuard({
    ...registrationConfig,
    loginIpLimit: 1,
  } as UserConfig);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ ip: '127.0.0.1', socket: {}, headers: {} }),
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  } as unknown as ExecutionContext;
  assert.equal(guard.canActivate(context), true);
  assert.throws(
    () => guard.canActivate(context),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
});

test('Login performs bounded password verification for missing accounts and returns generic failures', async () => {
  const checked: string[] = [];
  const service = new AuthenticationService(
    { user: { findUnique: async () => null } } as unknown as UserPrismaService,
    {
      verify: async (_password: string, hash: string) => {
        checked.push(hash);
        return false;
      },
    } as unknown as PasswordHasher,
    { ...tokenSettings, privateKey: keys.privateKey, lifetimeSeconds: 900 },
    auth,
  );
  await assert.rejects(
    service.login({ email: 'missing@example.com', password }),
    (error: unknown) =>
      error instanceof HttpException &&
      error.getStatus() === 401 &&
      error.message === 'Invalid email or password',
  );
  assert.match(checked[0], /^scrypt\$131072\$8\$1\$/);
});

test(
  'Public User login tokens scope Wallet reads/actions to their subject and reject service credentials',
  { skip: !enabled },
  async () => {
    const userApp = await NestFactory.create<NestExpressApplication>(UserApiTestModule, {
      logger: false,
      bodyParser: false,
    });
    userApp.useBodyParser('json', { limit: '8kb' });
    userApp.useGlobalFilters(new UserErrorsFilter());
    const walletApp = await NestFactory.create(WalletApiTestModule, { logger: false });
    walletApp.useGlobalFilters(new SafeErrorsFilter());
    setupOpenApi(walletApp);
    await userApp.listen(0, '127.0.0.1');
    await walletApp.listen(0, '127.0.0.1');
    const userUrl = await userApp.getUrl(),
      walletUrl = await walletApp.getUrl();
    const request = (base: string, path: string, token?: string, body?: unknown) =>
      fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const registration = await request(userUrl, '/v1/users/register', undefined, {
        email: `${prefix}-alice@example.com`,
        password,
      });
      assert.equal(registration.status, 201);
      const alice = (await registration.json()) as { userId: string };
      assert.equal('walletProvisioning' in alice, false);
      const signedIn = await request(userUrl, '/v1/users/login', undefined, {
        email: ` ${prefix.toUpperCase()}-ALICE@EXAMPLE.COM `,
        password,
      });
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.headers.get('cache-control'), 'no-store');
      const token = (await signedIn.json()) as { accessToken: string };
      const identity = await new AccessTokenVerifier(keys.publicKey, {
        ...tokenSettings,
        resetEpoch: auth.resetEpoch,
      }).verify(token.accessToken);
      assert.equal(identity.userId, alice.userId);
      const pending = await request(walletUrl, '/v1/me', token.accessToken);
      assert.equal(pending.status, 202);
      assert.equal((await pending.json()).state, 'awaiting_customer_registration');
      await deliverIdentity(alice.userId);
      const balances = await request(walletUrl, '/v1/me/balances', token.accessToken);
      assert.equal(balances.status, 200);
      assert.equal((await balances.json()).customerId, alice.userId);
      for (const bearer of [undefined, 'e'.repeat(64), 'w'.repeat(64)])
        assert.equal((await request(walletUrl, '/v1/me/balances', bearer)).status, 401);
      assert.equal(
        (await request(walletUrl, `/internal/customers/${alice.userId}`, token.accessToken)).status,
        401,
      );
      assert.equal(
        (await request(walletUrl, `/v1/customers/${alice.userId}`, token.accessToken)).status,
        404,
      );
      assert.equal((await request(walletUrl, '/v1/wallets', token.accessToken, {})).status, 404);
      for (const body of [
        { chain: 'ethereum', network: '1' },
        { chain: 'ethereum', network: 'arbitrary-network' },
        { chain: 'bitcoin', network: 'regtest' },
        { chain: 'ethereum', network: '11155111', customerId: randomUUID() },
      ])
        assert.equal(
          (await request(walletUrl, '/v1/me/deposit-addresses', token.accessToken, body)).status,
          400,
        );
      assert.equal(
        await wallet!.exchangeDepositAddressAssignment.count({
          where: { customer_id: alice.userId },
        }),
        0,
      );
      const assigned = await request(walletUrl, '/v1/me/deposit-addresses', token.accessToken, {
        chain: 'ethereum',
        network: '11155111',
      });
      assert.equal(assigned.status, 201);
      const address = (await assigned.json()) as { assignmentId: string; state: string };
      assert.equal(address.state, 'waiting');
      const bob = await users!.register({ email: `${prefix}-bob@example.com`, password });
      await deliverIdentity(bob.userId);
      const bobToken = await login!.login({ email: `${prefix}-bob@example.com`, password });
      assert.equal(
        (
          await request(
            walletUrl,
            `/v1/me/deposit-addresses/${address.assignmentId}`,
            bobToken.accessToken,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            walletUrl,
            `/v1/me/balances?customerId=${alice.userId}`,
            bobToken.accessToken,
          )
        ).status,
        400,
      );
      const payout = {
        asset: { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' },
        destination: '0x' + 'aa'.repeat(20),
        amount: '1',
        idempotencyKey: randomUUID(),
      };
      const requested = await request(walletUrl, '/v1/me/withdrawals', token.accessToken, payout);
      assert.equal(requested.status, 201);
      const withdrawal = await requested.json();
      assert.equal(withdrawal.customerId, alice.userId);
      for (const bearer of [undefined, 'e'.repeat(64), 'w'.repeat(64)])
        assert.equal((await request(walletUrl, '/v1/me/withdrawals', bearer, payout)).status, 401);
      assert.equal(
        (
          await request(walletUrl, '/v1/me/withdrawals', token.accessToken, {
            ...payout,
            customerId: bob.userId,
          })
        ).status,
        400,
      );
      assert.equal(
        (await request(walletUrl, `/v1/me/withdrawals/${withdrawal.id}`, bobToken.accessToken))
          .status,
        404,
      );
      assert.equal(
        (
          await request(
            walletUrl,
            `/v1/me/withdrawals/${withdrawal.id}/cancel`,
            bobToken.accessToken,
            {},
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            walletUrl,
            '/v1/me/withdrawals?customerId=' + alice.userId,
            bobToken.accessToken,
          )
        ).status,
        400,
      );
      assert.equal(
        (await request(walletUrl, `/v1/me/withdrawals/${withdrawal.id}`, token.accessToken)).status,
        200,
      );
      const docs = await (await request(walletUrl, '/docs-json')).json();
      assert.ok(Object.keys(docs.paths).every((path) => path.startsWith('/v1/me')));
      assert.ok(docs.components.securitySchemes.customerBearer);
      const failures = [];
      for (const body of [
        { email: `${prefix}-alice@example.com`, password: password.trim() },
        { email: `${prefix}-missing@example.com`, password },
      ]) {
        const failed = await request(userUrl, '/v1/users/login', undefined, body);
        assert.equal(failed.status, 401);
        failures.push(await failed.json());
      }
      assert.deepEqual(failures[0], failures[1]);
      assert.equal(JSON.stringify(failures).includes(password), false);
      assert.equal(
        (await user!.user.findUniqueOrThrow({ where: { id: alice.userId } })).email,
        `${prefix}-alice@example.com`,
      );
    } finally {
      await Promise.all([userApp.close(), walletApp.close()]);
    }
  },
);
