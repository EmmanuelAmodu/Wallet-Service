import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UserPrismaService } from '../apps/user/src/prisma/prisma.service.js';
import { UsersService } from '../apps/user/src/users/users.service.js';
import { PasswordHasher } from '../apps/user/src/users/password-hasher.service.js';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { ExchangeCustomersService } from '../apps/wallet/src/customers/customers.service.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { AccountsService } from '../apps/ledger/src/accounts/accounts.service.js';
import { SweepPrismaService } from '../apps/sweep/src/prisma/prisma.service.js';
import { SweepService } from '../apps/sweep/src/sweep/sweep.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { migrate } from '../scripts/migrate.js';

const enabled =
  !!process.env.TEST_USER_DATABASE_URL &&
  !!process.env.TEST_DATABASE_URL &&
  !!process.env.TEST_LEDGER_DATABASE_URL &&
  !!process.env.TEST_SWEEP_DATABASE_URL;
const user = enabled
  ? new UserPrismaService({ databaseUrl: process.env.TEST_USER_DATABASE_URL! })
  : undefined;
const wallet = enabled
  ? new WalletPrismaService({ databaseUrl: process.env.TEST_DATABASE_URL! })
  : undefined;
const ledger = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const sweep = enabled
  ? new SweepPrismaService({ databaseUrl: process.env.TEST_SWEEP_DATABASE_URL! })
  : undefined;
const auth = new MessageAuth('x'.repeat(64), 'registration-integration-epoch');
const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' } as const;
const journal = new JournalService(new AccountsService());
const domains = new Set<string>();

before(async () => {
  if (!enabled) return;
  for (const [url, app] of [
    [process.env.TEST_USER_DATABASE_URL!, 'user'],
    [process.env.TEST_DATABASE_URL!, 'wallet'],
    [process.env.TEST_LEDGER_DATABASE_URL!, 'ledger'],
    [process.env.TEST_SWEEP_DATABASE_URL!, 'sweep'],
  ] as const)
    await migrate(url, app);
});
after(async () => {
  if (enabled)
    for (const domainId of domains) {
      // Retain append-only accounting history, but retire this fixture's unrelated queue epoch.
      const where = { payload: { path: ['domainId'], equals: domainId } };
      const registrations = await user!.outbox.findMany({ where });
      const userIds = registrations
        .map((row) => {
          const event = exchangeEventSchema.parse(row.payload);
          return event.type === 'user.registered.v1' ? event.data.userId : '';
        })
        .filter(Boolean);
      await Promise.all([
        wallet!.outbox.deleteMany({ where }),
        ledger!.outbox.deleteMany({ where }),
        sweep!.outbox.deleteMany({ where }),
        user!.outbox.deleteMany({ where }),
      ]);
      await user!.user.deleteMany({ where: { id: { in: userIds } } });
    }
  await Promise.all([
    user?.$disconnect(),
    wallet?.$disconnect(),
    ledger?.$disconnect(),
    sweep?.$disconnect(),
  ]);
});

function fixture() {
  const domainId = `user-bridge-${randomUUID()}`;
  domains.add(domainId);
  const settings = { domainId, apiKey: 'e'.repeat(64) };
  const customers = new ExchangeCustomersService(wallet!, settings, auth, {} as LedgerClient);
  const messaging = new ExchangeMessagingService(wallet!, auth, customers);
  const registry = new ExchangeRegistryService(ledger!);
  const sweeps = new SweepService(sweep!, auth, { domainId });
  const event = (
    type: ExchangeEvent['type'],
    data: unknown,
    extras: Record<string, unknown> = {},
  ) =>
    exchangeEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: 1,
      resetEpoch: auth.resetEpoch,
      occurredAt: new Date().toISOString(),
      domainId,
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: randomUUID(),
      revision: 1,
      type,
      data,
      ...extras,
    });
  return { domainId, settings, customers, messaging, registry, sweeps, event };
}

// Uses real application-owned databases; never imports a foreign database into an application service.
test(
  'User registration provisions matching Wallet/Ledger UUIDs once without credential fanout',
  { skip: !enabled },
  async () => {
    const f = fixture();
    const users = new UsersService(
      user!,
      new PasswordHasher({ hashConcurrency: 1 }),
      f.settings,
      auth,
    );
    const email = `bridge-${randomUUID()}@example.com`,
      password = 'A private registration phrase 🔑';
    const registered = await users.register({ email, password });
    const delivery = await user!.outbox.findFirstOrThrow({
      where: { payload: { path: ['data', 'userId'], equals: registered.userId } },
    });
    const signal = auth.open(
      auth.seal(exchangeEventSchema.parse(delivery.payload), delivery.id),
      delivery.id,
      'user.registered.v1',
    );
    assert.equal(delivery.queue, QUEUES.wallet);
    assert.equal(JSON.stringify(delivery.payload).includes(email), false);
    assert.equal(JSON.stringify(delivery.payload).includes(password), false);
    await Promise.all([
      f.messaging.handle(signal as ExchangeEvent),
      f.messaging.handle(signal as ExchangeEvent),
    ]);
    const customer = await wallet!.exchangeCustomer.findUniqueOrThrow({
      where: { customer_id: registered.userId },
    });
    assert.equal(customer.external_id, registered.userId);
    assert.equal(customer.ledger_status, 'pending');
    const commands = await wallet!.outbox.findMany({
      where: { queue: QUEUES.ledger, payload: { path: ['customerId'], equals: registered.userId } },
    });
    assert.equal(commands.length, 1);
    const command = exchangeEventSchema.parse(commands[0].payload);
    assert.notEqual(command.eventId, (signal as ExchangeEvent).eventId);
    assert.equal(command.causationId, (signal as ExchangeEvent).eventId);
    await f.registry.handle(command);
    const ack = await ledger!.outbox.findFirstOrThrow({
      where: { payload: { path: ['causationId'], equals: command.eventId } },
    });
    await f.messaging.handle(exchangeEventSchema.parse(ack.payload));
    assert.equal(
      (
        await wallet!.exchangeCustomer.findUniqueOrThrow({
          where: { customer_id: registered.userId },
        })
      ).ledger_status,
      'ready',
    );
    await wallet!.exchangeCustomer.update({
      where: { customer_id: registered.userId },
      data: { state: 'frozen' },
    });
    await f.messaging.handle({ ...(signal as ExchangeEvent), eventId: randomUUID() });
    assert.equal((await f.customers.get(registered.userId)).state, 'frozen');
    assert.equal(
      await wallet!.outbox.count({
        where: {
          queue: QUEUES.ledger,
          payload: { path: ['customerId'], equals: registered.userId },
        },
      }),
      1,
    );
  },
);

test(
  'Failed Wallet provisioning rolls back customer and receipt; replay can safely recover the User',
  { skip: !enabled },
  async () => {
    const f = fixture(),
      userId = randomUUID();
    const event = f.event(
      'user.registered.v1',
      { userId },
      { customerId: userId, aggregateId: userId },
    );
    class InterruptedProjection extends ExchangeCustomersService {
      async registerUser(...args: Parameters<ExchangeCustomersService['registerUser']>) {
        await super.registerUser(...args);
        throw new Error('Injected post-outbox failure');
      }
    }
    const interrupted = new ExchangeMessagingService(
      wallet!,
      auth,
      new InterruptedProjection(wallet!, f.settings, auth, {} as LedgerClient),
    );
    await assert.rejects(interrupted.handle(event), /post-outbox failure/);
    assert.equal(
      await wallet!.exchangeCustomer.findUnique({ where: { customer_id: userId } }),
      null,
    );
    assert.equal(
      await wallet!.exchangeEventReceipt.findUnique({ where: { event_id: event.eventId } }),
      null,
    );
    assert.equal(
      await wallet!.outbox.count({ where: { payload: { path: ['customerId'], equals: userId } } }),
      0,
    );
    await assert.rejects(f.customers.create(userId), /originate in User service/);
    await assert.rejects(f.messaging.handle({ ...event, domainId: 'foreign' }), /domain or epoch/);
    await f.messaging.handle(event);
    assert.equal((await f.customers.get(userId)).customerId, userId);
    await assert.rejects(
      f.messaging.handle({ ...event, occurredAt: new Date(0).toISOString() }),
      /different content/,
    );
  },
);

test(
  'Ledger commits independent identical Wallet/Sweep results and reordered delivery cannot recreate reversed work',
  { skip: !enabled },
  async () => {
    const f = fixture(),
      customerId = randomUUID(),
      walletId = randomUUID(),
      hotWalletId = randomUUID();
    const hot = f.event('custody-wallet.registry.requested.v1', {
      walletId: hotWalletId,
      role: 'hot',
      account: 0,
      chain: asset.chain,
      network: asset.network,
      address: '0x' + randomUUID().replaceAll('-', '').padEnd(40, 'a'),
      registryRevision: 1,
    });
    const source = f.event(
      'customer-wallet.registry.requested.v1',
      {
        walletId,
        hotWalletId,
        account: 10,
        chain: asset.chain,
        network: asset.network,
        address: '0x' + randomUUID().replaceAll('-', '').padEnd(40, 'b'),
        registryRevision: 1,
      },
      { customerId },
    );
    for (const event of [hot, source]) {
      await f.messaging.publishRegistry(event as never);
      await f.registry.handle(event);
      assert.equal(
        await wallet!.outbox.count({
          where: { payload: { path: ['eventId'], equals: event.eventId } },
        }),
        3,
      );
    }
    const depositId = randomUUID();
    const deposit = f.event(
      'deposit.finalized.v1',
      {
        depositId,
        walletId,
        asset,
        amount: '100',
        transactionHash: '0x' + 'ab'.repeat(32),
        transferIdentity: { kind: 'evm.native', id: 'native' },
        blockHash: '0x' + 'cd'.repeat(32),
      },
      { customerId },
    );
    const deposits = new DepositsService(ledger!, journal, { resetEpoch: auth.resetEpoch });
    await deposits.handle(deposit);
    const outputs = await ledger!.outbox.findMany({
      where: { dedupe_key: { startsWith: `deposit:${depositId}:credited:` } },
    });
    assert.equal(outputs.length, 2);
    assert.deepEqual(
      new Set(outputs.map((row) => row.queue)),
      new Set([QUEUES.wallet, QUEUES.sweep]),
    );
    assert.deepEqual(outputs[0].payload, outputs[1].payload);
    const credit = exchangeEventSchema.parse(outputs[0].payload);
    await f.sweeps.handle(credit);
    await f.sweeps.handle(source);
    await f.sweeps.handle(hot);
    let work = await sweep!.sweepWork.findFirstOrThrow({ where: { domain_id: f.domainId } });
    assert.equal(work.state, 'blocked_execution_not_implemented');
    assert.equal(work.observed_credit_units, '100');
    await deposits.handle(
      f.event(
        'deposit.reverted.v1',
        {
          depositId,
          asset,
          transactionHash: '0x' + 'ab'.repeat(32),
          transferIdentity: { kind: 'evm.native', id: 'native' },
          reason: 'canonical block replaced',
        },
        { customerId, revision: 2 },
      ),
    );
    const reversal = await ledger!.outbox.findFirstOrThrow({
      where: { dedupe_key: `deposit:${depositId}:reversed:2:sweep` },
    });
    await f.sweeps.handle(exchangeEventSchema.parse(reversal.payload));
    await f.sweeps.handle({ ...credit, eventId: randomUUID() });
    work = await sweep!.sweepWork.findFirstOrThrow({ where: { domain_id: f.domainId } });
    assert.equal(work.observed_credit_units, '0');
    assert.equal(work.state, 'no_credited_deposits');
    assert.equal(
      await sweep!.outbox.count({ where: { payload: { path: ['domainId'], equals: f.domainId } } }),
      0,
    );
    assert.equal(await ledger!.journalBatch.count({ where: { domain_id: f.domainId } }), 2);
  },
);
