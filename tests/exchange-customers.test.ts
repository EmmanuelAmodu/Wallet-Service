import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { Controller, Get, Module, Req } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { createDatabase, WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { ExchangeCustomersService } from '../apps/wallet/src/customers/customers.service.js';
import { ExchangeCustomersController } from '../apps/wallet/src/customers/customers.controller.js';
import { ExchangeBackendGuard } from '../apps/wallet/src/customers/exchange-backend.guard.js';
import { exchangeApiConfig } from '../apps/wallet/src/config/exchange-api.config.js';
import { walletConfig, WalletSettings } from '../apps/wallet/src/config/wallet.config.js';
import { WalletAuthGuard } from '../apps/wallet/src/auth/wallet-auth.guard.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { migrate } from '../scripts/migrate.js';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { custodySettings, isolatedDatabase, testMnemonic } from './helpers/custody-fixture.js';

const enabled = !!process.env.TEST_DATABASE_URL;
let db: ReturnType<typeof createDatabase>;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
let custody: CustodyService;
let signing: SigningCore;
const ledgerDb =
  enabled && process.env.TEST_LEDGER_DATABASE_URL
    ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL })
    : undefined;
const ledgerRegistry = ledgerDb ? new ExchangeRegistryService(ledgerDb) : undefined;
const ledgerReceiptIds: string[] = [];
const settings = { domainId: `customers-test-${randomUUID()}`, apiKey: 'e'.repeat(64) };
const auth = new MessageAuth('q'.repeat(64), 'customers-test');
const asset = { chain: 'ethereum' as const, network: '11155111', assetId: 'token:ethereum:native' };
const ledger = {
  exchangeBalances: async (domainId: string, customerId: string) => ({
    customerId,
    domainId,
    state: 'active',
    balances: [],
  }),
} as unknown as LedgerClient;
let service: ExchangeCustomersService;
const externalPrefix = `customers-${randomUUID()}`;

function event<T extends ExchangeEvent['type']>(
  type: T,
  customerId: string,
  data: unknown,
  revision = 1,
) {
  return exchangeEventSchema.parse({
    eventId: randomUUID(),
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId: settings.domainId,
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision,
    customerId,
    type,
    data,
  }) as Extract<ExchangeEvent, { type: T }>;
}

async function register(customerId: string, ready = false) {
  const customer = await db!.exchangeCustomer.findUniqueOrThrow({
    where: { customer_id: customerId },
  });
  await service!.project(
    event('customer.registry.acknowledged.v1', customerId, {
      externalId: customer.external_id,
      status: 'ready',
    }),
  );
  const hot = await db.wallet.findFirstOrThrow({
    where: { chain: asset.chain, custody_role: 'hot' },
  });
  const manager = await db.wallet.findFirstOrThrow({
    where: { chain: asset.chain, custody_role: 'management' },
  });
  const owned = await db.$transaction((tx) =>
    custody.allocateCustomer(tx, customerId, asset.chain, asset.network),
  );
  for (const wallet of [hot, manager, owned]) {
    const derived = signing.derive({
      chain: asset.chain,
      seedId: wallet.seed_id,
      account: wallet.account,
    });
    await db.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { status: 'ready', address: derived.address.toLowerCase() },
      });
      await custody.markPublished(tx, wallet.id, 1);
    });
    await db.exchangeWalletRegistry.upsert({
      where: { wallet_id: wallet.id },
      update: {},
      create: {
        wallet_id: wallet.id,
        domain_id: settings.domainId,
        reset_epoch: auth.resetEpoch,
        chain: asset.chain,
        network: asset.network,
        registry_revision: 1,
        request: {},
        ledger_status: 'ready',
        ledger_ack_revision: 1,
        role: wallet.custody_role,
        account: wallet.account,
        address: derived.address.toLowerCase(),
        customer_id: wallet.customer_id,
        hot_wallet_id: wallet.hot_wallet_id,
        listener_status: ready && wallet.id === owned.id ? 'ready' : 'pending',
        listener_ack_revision: ready && wallet.id === owned.id ? 1 : 0,
        start_cursor: ready && wallet.id === owned.id ? 'verified-block-1' : null,
        ready: ready && wallet.id === owned.id,
      },
    });
  }
  const hotWalletId = hot.id;
  const walletId = owned.id;
  const management = { wallet_id: manager.id };
  return { walletId, hotWalletId, managementWalletId: management.wallet_id };
}

before(async () => {
  if (enabled) {
    fixture = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    db = createDatabase(fixture.url);
    const config = custodySettings(settings.domainId);
    custody = new CustodyService(db as WalletPrismaService, config, settings, auth);
    signing = await SigningCore.create(testMnemonic, config.seedId, config.ethereumChainId);
    service = new ExchangeCustomersService(
      db as WalletPrismaService,
      settings,
      auth,
      ledger,
      custody,
    );
    await custody.bootstrap();
  }
  if (ledgerDb) await migrate(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
});
after(async () => {
  if (!enabled) return;
  signing.close();
  await db.$disconnect();
  await fixture.drop();
  if (ledgerDb) {
    await ledgerDb.outbox.deleteMany({
      where: { payload: { path: ['domainId'], equals: settings.domainId } },
    });
    await ledgerDb.exchangeInbox.deleteMany({ where: { event_id: { in: ledgerReceiptIds } } });
    await ledgerDb.exchangeCustomer.deleteMany({ where: { domain_id: settings.domainId } });
    await ledgerDb.$disconnect();
  }
});

test(
  'customer identity and address assignment are idempotent across replicas and reserve no derivation',
  { skip: !enabled },
  async () => {
    const externalId = `${externalPrefix}-replicas`;
    const replica = new ExchangeCustomersService(
      db as WalletPrismaService,
      settings,
      auth,
      ledger,
      custody,
    );
    const customers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? service! : replica).create(externalId)),
    );
    assert.equal(new Set(customers.map((row) => row.customerId)).size, 1);
    const customerId = customers[0].customerId;
    const customerDeliveries = await db!.outbox.findMany({
      where: { payload: { path: ['customerId'], equals: customerId } },
    });
    assert.equal(customerDeliveries.length, 1);
    const request = exchangeEventSchema.parse(customerDeliveries[0].payload);
    assert.equal(request.type, 'customer.registry.requested.v1');
    assert.equal(customerDeliveries[0].queue, QUEUES.ledger);
    const waiting = await service!.balances(customerId);
    assert.equal(waiting.state, 'awaiting_ledger_registration');
    assert.equal('balances' in waiting, false);
    const waitingAddress = await service!.assign(customerId, asset.chain, asset.network);
    assert.ok(waitingAddress.state === 'waiting');
    assert.equal(waitingAddress.reason, 'customer_ledger_not_ready');
    assert.equal('address' in waitingAddress, false);
    await db!.outbox.delete({ where: { id: customerDeliveries[0].id } });
    await service!.create(externalId);
    const repaired = await db!.outbox.findMany({
      where: { payload: { path: ['customerId'], equals: customerId } },
    });
    assert.equal(repaired.length, 1);
    assert.deepEqual(repaired[0].payload, customerDeliveries[0].payload);
    await assert.rejects(
      () =>
        service!.project(
          event('customer.registry.acknowledged.v1', customerId, {
            externalId: 'incorrect-external-id',
            status: 'ready',
          }),
        ),
      /identity mismatch/,
    );
    await service!.project(
      event('customer.registry.acknowledged.v1', customerId, { externalId, status: 'ready' }),
    );
    const registeredBalances = await service!.balances(customerId);
    assert.ok('balances' in registeredBalances);
    assert.deepEqual(registeredBalances.balances, []);
    const assignments = await Promise.all(
      Array.from({ length: 8 }, () => service!.assign(customerId, asset.chain, asset.network)),
    );
    assert.equal(new Set(assignments.map((row) => row.assignmentId)).size, 1);
    assert.equal(assignments[0].state, 'waiting');
    assert.ok(assignments[0].state === 'waiting');
    assert.equal(assignments[0].reason, 'custody_bootstrap_required');
    assert.equal('address' in assignments[0], false);
    assert.equal(await db!.wallet.count({ where: { external_id: externalId } }), 0);
    await register(customerId, true);
    assert.equal(
      (await service!.assignment(customerId, assignments[0].assignmentId)).state,
      'ready',
    );
    const otherDomain = new ExchangeCustomersService(
      db as WalletPrismaService,
      { ...settings, domainId: 'other-domain' },
      auth,
      ledger,
    );
    await assert.rejects(() => otherDomain.create(externalId), /another custody domain/);
    const stale = new ExchangeCustomersService(
      db as WalletPrismaService,
      settings,
      new MessageAuth('q'.repeat(64), 'old-epoch'),
      ledger,
    );
    await assert.rejects(() => stale.get(customerId), /Customer not found/);
  },
);

test(
  'customer registration creates empty Ledger liabilities before wallet allocation and replay preserves a freeze',
  { skip: !ledgerDb },
  async () => {
    const customer = await service!.create(`${externalPrefix}-ledger-registration`);
    const delivery = await db!.outbox.findFirstOrThrow({
      where: { payload: { path: ['customerId'], equals: customer.customerId } },
    });
    const request = exchangeEventSchema.parse(delivery.payload);
    ledgerReceiptIds.push(request.eventId);
    await ledgerRegistry!.handle(request);
    await ledgerRegistry!.handle(request);
    const replies = await ledgerDb!.outbox.findMany({
      where: { payload: { path: ['causationId'], equals: request.eventId } },
    });
    assert.equal(replies.length, 1);
    const acknowledgment = exchangeEventSchema.parse(replies[0].payload);
    assert.equal(acknowledgment.type, 'customer.registry.acknowledged.v1');
    await new ExchangeMessagingService(db as WalletPrismaService, auth, service).handle(
      acknowledgment,
    );
    assert.equal(
      await ledgerDb!.exchangeWallet.count({ where: { customer_id: customer.customerId } }),
      0,
    );
    const server = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${'l'.repeat(64)}`);
      const balances = await ledgerRegistry!.balances(settings.domainId, customer.customerId);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(balances));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new LedgerClient({
      ledgerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ledgerApiKey: 'l'.repeat(64),
    } as WalletSettings);
    const customerService = new ExchangeCustomersService(
      db as WalletPrismaService,
      settings,
      auth,
      client,
    );
    try {
      const balances = await customerService.balances(customer.customerId);
      assert.ok('balances' in balances);
      assert.deepEqual(balances.balances, []);
      assert.equal(balances.state, 'active');
      await ledgerDb!.exchangeCustomer.update({
        where: { customer_id: customer.customerId },
        data: { state: 'frozen' },
      });
      await service!.create(`${externalPrefix}-ledger-registration`);
      await ledgerRegistry!.handle(request);
      assert.equal((await customerService.balances(customer.customerId)).state, 'frozen');
    } finally {
      server.close();
      await once(server, 'close');
    }
  },
);

test(
  'only current ready customer registry and registered hot0 expose an address; ownership and revisions remain fenced',
  { skip: !enabled },
  async () => {
    const customer = await service!.create(`${externalPrefix}-readiness`);
    const { walletId, hotWalletId, managementWalletId } = await register(customer.customerId);
    const assignment = await service!.assign(customer.customerId, asset.chain, asset.network);
    assert.ok(assignment.state === 'waiting');
    assert.equal(assignment.reason, 'registry_subscription_not_ready');
    assert.equal('address' in assignment, false);
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: walletId },
      data: {
        listener_status: 'ready',
        listener_ack_revision: 1,
        start_cursor: 'certified-backfill',
        ready: true,
      },
    });
    const ready = await service!.assignment(customer.customerId, assignment.assignmentId);
    assert.equal(ready.state, 'ready');
    assert.ok(ready.state === 'ready');
    assert.equal(ready.walletId, walletId);
    assert.equal(typeof ready.address, 'string');
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: managementWalletId },
      data: { ledger_status: 'pending' },
    });
    const missingManagement = await service!.assignment(
      customer.customerId,
      assignment.assignmentId,
    );
    assert.ok(missingManagement.state === 'waiting');
    assert.equal(missingManagement.reason, 'management_wallet_not_ready');
    assert.equal('address' in missingManagement, false);
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: managementWalletId },
      data: { ledger_status: 'ready', reset_epoch: 'old-epoch' },
    });
    assert.equal(
      'address' in (await service!.assignment(customer.customerId, assignment.assignmentId)),
      false,
    );
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: managementWalletId },
      data: { reset_epoch: auth.resetEpoch },
    });
    assert.equal(
      (await service!.assignment(customer.customerId, assignment.assignmentId)).state,
      'ready',
    );
    await db.$transaction((tx) => custody.markPublished(tx, walletId, 2));
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: walletId },
      data: {
        registry_revision: 2,
        ledger_status: 'pending',
        listener_status: 'pending',
        ready: false,
        start_cursor: null,
      },
    });
    assert.equal(
      'address' in (await service!.assignment(customer.customerId, assignment.assignmentId)),
      false,
    );
    await db!.exchangeWalletRegistry.update({
      where: { wallet_id: hotWalletId },
      data: { ledger_status: 'pending' },
    });
    const unavailableHot = await service!.assignment(customer.customerId, assignment.assignmentId);
    assert.ok(unavailableHot.state === 'waiting');
    assert.equal(unavailableHot.reason, 'hot_wallet_not_ready');
    const other = await service!.create(`${externalPrefix}-different-owner`);
    await assert.rejects(
      () => service!.assignment(other.customerId, assignment.assignmentId),
      /not found/,
    );
  },
);

test(
  'deposit history preserves Ledger truth when credit arrives first and delayed discovery follows a reversal',
  { skip: !enabled },
  async () => {
    const customer = await service!.create(`${externalPrefix}-history`);
    const { walletId } = await register(customer.customerId, true);
    const depositId = randomUUID();
    const credited = event(
      'deposit.credited.v1',
      customer.customerId,
      { depositId, ledgerBatchId: randomUUID(), walletId, asset, amount: '100' },
      2,
    );
    await service!.project(credited);
    const observed = event('deposit.observed.v1', customer.customerId, {
      depositId,
      walletId,
      asset,
      amount: '100',
      transactionHash: '0xsame-transaction',
      transferIdentity: { kind: 'evm.native', id: 'root' },
    });
    await service!.project(observed);
    await service!.project(observed);
    let row = (await service!.deposits(customer.customerId)).deposits[0];
    assert.equal(row.state, 'credited');
    assert.equal(row.transactionHash, '0xsame-transaction');
    assert.deepEqual(row.transferIdentity, { kind: 'evm.native', id: 'root' });
    const reversed = event(
      'deposit.reversed.v1',
      customer.customerId,
      {
        depositId,
        ledgerBatchId: randomUUID(),
        asset,
        amount: '100',
        reason: 'canonical block changed',
        deficitIncidentId: randomUUID(),
      },
      3,
    );
    await service!.project(reversed);
    await service!.project(credited);
    await service!.project(
      event(
        'deposit.finalized.v1',
        customer.customerId,
        { ...observed.data, blockHash: 'old-block' },
        2,
      ),
    );
    row = (await service!.deposits(customer.customerId)).deposits[0];
    assert.equal(row.state, 'reversed');
    assert.equal((await service!.get(customer.customerId)).state, 'frozen');
    await service!.project(
      event(
        'deposit.deficit-recorded.v1',
        customer.customerId,
        {
          depositId,
          incidentId: reversed.data.deficitIncidentId!,
          asset,
          amount: '30',
          reason: 'shortfall',
        },
        3,
      ),
    );
    assert.equal((await service!.deposits(customer.customerId)).deposits[0].amount, '100');
    await assert.rejects(
      () => service!.project({ ...observed, data: { ...observed.data, amount: '101' } }),
      /identity is immutable/,
    );
    await assert.rejects(
      () =>
        service!.project({ ...reversed, data: { ...reversed.data, ledgerBatchId: randomUUID() } }),
      /revision reused/,
    );
  },
);

test(
  'reversal tombstones prevent late credit and scoped pagination keeps multiple same-transaction transfers',
  { skip: !enabled },
  async () => {
    const customer = await service!.create(`${externalPrefix}-pagination`);
    const { walletId } = await register(customer.customerId, true);
    const firstId = randomUUID();
    await service!.project(
      event(
        'deposit.reversed.v1',
        customer.customerId,
        { depositId: firstId, ledgerBatchId: randomUUID(), asset, amount: '25', reason: 'reorg' },
        3,
      ),
    );
    await service!.project(
      event(
        'deposit.credited.v1',
        customer.customerId,
        { depositId: firstId, walletId, ledgerBatchId: randomUUID(), asset, amount: '25' },
        2,
      ),
    );
    assert.equal(
      (await db!.exchangeDepositProjection.findUniqueOrThrow({ where: { deposit_id: firstId } }))
        .accounting_state,
      'reversed',
    );
    for (let i = 0; i < 3; i++)
      await service!.project(
        event('deposit.observed.v1', customer.customerId, {
          depositId: randomUUID(),
          walletId,
          asset,
          amount: '25',
          transactionHash: '0xmulti',
          transferIdentity: { kind: 'evm.trace', id: `trace:${i}` },
        }),
      );
    const page1 = await service!.deposits(customer.customerId, undefined, 2);
    assert.equal(page1.deposits.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await service!.deposits(customer.customerId, page1.nextCursor!, 2);
    assert.equal(page2.deposits.length, 2);
    assert.equal(page2.nextCursor, null);
    assert.equal(
      new Set([...page1.deposits, ...page2.deposits].map((row) => row.depositId)).size,
      4,
    );
    const other = await service!.create(`${externalPrefix}-other-pagination`);
    await assert.rejects(
      () => service!.deposits(other.customerId, page1.nextCursor!),
      /cursor not found/,
    );
    await assert.rejects(
      () =>
        service!.project(
          event('deposit.observed.v1', other.customerId, {
            depositId: randomUUID(),
            walletId,
            asset,
            amount: '25',
            transactionHash: '0xwrong-owner',
            transferIdentity: { kind: 'evm.native', id: 'root' },
          }),
        ),
      /ownership mismatch/,
    );
  },
);

test(
  'exchange HTTP requires a separate backend credential and rejects customer/domain overrides',
  { skip: !enabled },
  async () => {
    @Controller('legacy-auth-test')
    class LegacyController {
      @Get()
      current(@Req() request: { tenant?: string }) {
        return { authenticated: true, hasTenant: 'tenant' in request };
      }
    }
    const legacyApiKey = 'legacy'.repeat(8);
    @Module({
      controllers: [ExchangeCustomersController, LegacyController],
      providers: [
        ExchangeBackendGuard,
        { provide: APP_GUARD, useClass: WalletAuthGuard },
        { provide: walletConfig.KEY, useValue: { apiKey: legacyApiKey } },
        { provide: exchangeApiConfig.KEY, useValue: settings },
        { provide: ExchangeCustomersService, useValue: service },
      ],
    })
    class TestModule {}
    const app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalFilters(new SafeErrorsFilter());
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();
    try {
      const legacyAllowed = await fetch(`${baseUrl}/legacy-auth-test`, {
        headers: { authorization: `Bearer ${legacyApiKey}` },
      });
      assert.equal(legacyAllowed.status, 200);
      assert.deepEqual(await legacyAllowed.json(), { authenticated: true, hasTenant: false });
      const exchangeOnLegacy = await fetch(`${baseUrl}/legacy-auth-test`, {
        headers: { authorization: `Bearer ${settings.apiKey}` },
      });
      assert.equal(exchangeOnLegacy.status, 401);
      const customer = await service!.create(`${externalPrefix}-http`);
      for (const authorization of [undefined, `Bearer ${'legacy'.repeat(8)}`]) {
        const response = await fetch(`${baseUrl}/internal/customers/${customer.customerId}`, {
          headers: {
            ...(authorization ? { authorization } : {}),
          },
        });
        assert.equal(response.status, 401);
      }
      const headers = {
        authorization: `Bearer ${settings.apiKey}`,
        'content-type': 'application/json',
      };
      const removedRegistration = await fetch(`${baseUrl}/internal/customers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ externalId: `${externalPrefix}-http` }),
      });
      assert.equal(removedRegistration.status, 404);
      const rejected = await fetch(
        `${baseUrl}/internal/customers/${customer.customerId}/deposit-addresses`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chain: asset.chain,
            network: asset.network,
            customerId: randomUUID(),
            domainId: 'attacker',
          }),
        },
      );
      assert.equal(rejected.status, 400);
      const balances = await fetch(
        `${baseUrl}/internal/customers/${customer.customerId}/balances`,
        {
          headers,
        },
      );
      assert.equal(balances.status, 202);
      assert.deepEqual(await balances.json(), {
        customerId: customer.customerId,
        state: 'awaiting_ledger_registration',
      });
      await service!.project(
        event('customer.registry.acknowledged.v1', customer.customerId, {
          externalId: `${externalPrefix}-http`,
          status: 'ready',
        }),
      );
      assert.equal(
        (await fetch(`${baseUrl}/internal/customers/${customer.customerId}/balances`, { headers }))
          .status,
        200,
      );
      const override = await fetch(
        `${baseUrl}/internal/customers/${customer.customerId}/balances?domainId=attacker`,
        { headers },
      );
      assert.equal(override.status, 400);
      const history = await fetch(
        `${baseUrl}/internal/customers/${customer.customerId}/deposits?limit=101`,
        { headers },
      );
      assert.equal(history.status, 400);
    } finally {
      await app.close();
    }
  },
);

test(
  'Wallet customer projection and delivery receipt commit atomically and reject duplicate changed evidence',
  { skip: !enabled },
  async () => {
    const customer = await service!.create(`${externalPrefix}-consumer`);
    const { walletId } = await register(customer.customerId, true);
    const messaging = new ExchangeMessagingService(db as WalletPrismaService, auth, service);
    const credited = event(
      'deposit.credited.v1',
      customer.customerId,
      { depositId: randomUUID(), walletId, ledgerBatchId: randomUUID(), asset, amount: '99' },
      2,
    );
    await messaging.handle(credited);
    await messaging.handle(credited);
    assert.equal(
      await db!.exchangeDepositProjection.count({ where: { deposit_id: credited.data.depositId } }),
      1,
    );
    assert.equal(
      await db!.exchangeEventReceipt.count({ where: { event_id: credited.eventId } }),
      1,
    );
    await assert.rejects(
      () => messaging.handle({ ...credited, data: { ...credited.data, amount: '100' } }),
      /Event identity reused/,
    );
    const wrongWallet = event(
      'deposit.credited.v1',
      customer.customerId,
      {
        depositId: randomUUID(),
        walletId: randomUUID(),
        ledgerBatchId: randomUUID(),
        asset,
        amount: '99',
      },
      2,
    );
    await assert.rejects(() => messaging.handle(wrongWallet), /registry has not committed/);
    assert.equal(
      await db!.exchangeDepositProjection.count({
        where: { deposit_id: wrongWallet.data.depositId },
      }),
      0,
    );
    assert.equal(
      await db!.exchangeEventReceipt.count({ where: { event_id: wrongWallet.eventId } }),
      0,
    );
    assert.equal(await db!.inbox.count({ where: { id: `wallet:${wrongWallet.eventId}` } }), 0);
  },
);

test(
  'custody loss and critical incidents freeze only the owned customer and recovery never silently thaws',
  { skip: !enabled },
  async () => {
    const customer = await service!.create(`${externalPrefix}-custody-loss`);
    const other = await service!.create(`${externalPrefix}-custody-loss-other`);
    const { walletId } = await register(customer.customerId, true);
    const loss = event('custody.loss.recorded.v1', customer.customerId, {
      incidentId: randomUUID(),
      ledgerBatchId: randomUUID(),
      walletId,
      asset,
      amount: '25',
      transactionHash: '0xunexpected',
    });
    await assert.rejects(
      () => service!.project({ ...loss, customerId: other.customerId }),
      /wallet ownership mismatch/,
    );
    assert.equal((await service!.get(other.customerId)).state, 'active');
    await service!.project(loss);
    assert.equal((await service!.get(customer.customerId)).state, 'frozen');
    await service!.project(
      event(
        'custody.loss.reverted.v1',
        customer.customerId,
        {
          incidentId: loss.data.incidentId,
          walletId,
          asset,
          amount: '25',
          transactionHash: '0xunexpected',
          reason: 'chain reorg',
        },
        2,
      ),
    );
    assert.equal((await service!.get(customer.customerId)).state, 'frozen');
    await service!.project(
      event('custody.incident.opened.v1', other.customerId, {
        incidentId: randomUUID(),
        severity: 'low',
        category: 'provider_delay',
        status: 'open',
        reason: 'informational',
      }),
    );
    assert.equal((await service!.get(other.customerId)).state, 'active');
    const critical = event('custody.incident.opened.v1', other.customerId, {
      incidentId: randomUUID(),
      severity: 'critical',
      category: 'unexpected_outflow',
      status: 'open',
      reason: 'custody compromise',
    });
    await assert.rejects(
      () => service!.project({ ...critical, domainId: 'other-domain' }),
      /domain\/epoch mismatch/,
    );
    await service!.project(critical);
    assert.equal((await service!.get(other.customerId)).state, 'frozen');
    const reversalFirst = await service!.create(`${externalPrefix}-custody-reversal-first`);
    const reversalWallet = await register(reversalFirst.customerId, true);
    await service!.project(
      event(
        'custody.loss.reverted.v1',
        reversalFirst.customerId,
        {
          incidentId: randomUUID(),
          walletId: reversalWallet.walletId,
          asset,
          amount: '25',
          transactionHash: '0xreversal-first',
          reason: 'Prior compromise still requires review',
        },
        2,
      ),
    );
    assert.equal((await service!.get(reversalFirst.customerId)).state, 'frozen');
  },
);

test('Ledger HTTP response validation preserves scoped asset units and rejects swapped identity or duplicate assets', async () => {
  const customerId = randomUUID();
  let responseBody: unknown = {
    customerId,
    domainId: settings.domainId,
    state: 'active',
    balances: [{ ...asset, available: '1', reserved: '0', frozen: '0', pending: '2' }],
  };
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${'l'.repeat(64)}`);
    assert.equal(
      new URL(request.url!, 'http://local').searchParams.get('domainId'),
      settings.domainId,
    );
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responseBody));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new LedgerClient({
    ledgerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ledgerApiKey: 'l'.repeat(64),
  } as WalletSettings);
  try {
    assert.equal(
      (await client.exchangeBalances(settings.domainId, customerId)).balances[0].available,
      '1',
    );
    const valid = responseBody as Record<string, unknown>;
    responseBody = { ...valid, customerId: randomUUID() };
    await assert.rejects(
      () => client.exchangeBalances(settings.domainId, customerId),
      /Ledger service is unavailable/,
    );
    responseBody = {
      ...valid,
      balances: [...(valid.balances as unknown[]), ...(valid.balances as unknown[])],
    };
    await assert.rejects(
      () => client.exchangeBalances(settings.domainId, customerId),
      /Ledger service is unavailable/,
    );
    responseBody = {
      ...valid,
      balances: [{ ...asset, available: '-1', reserved: '0', frozen: '0', pending: '2' }],
    };
    await assert.rejects(
      () => client.exchangeBalances(settings.domainId, customerId),
      /Ledger service is unavailable/,
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('exchange API configuration is opt-in and rejects reuse of queue, Ledger, or wallet backend keys', () => {
  const names = [
    'EXCHANGE_API_KEY',
    'EXCHANGE_DOMAIN_ID',
    'QUEUE_AUTH_KEY',
    'LEDGER_API_KEY',
    'WALLET_API_KEY',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.EXCHANGE_API_KEY;
    delete process.env.EXCHANGE_DOMAIN_ID;
    assert.equal(exchangeApiConfig().apiKey, undefined);
    process.env.EXCHANGE_DOMAIN_ID = settings.domainId;
    process.env.QUEUE_AUTH_KEY = 'q'.repeat(64);
    process.env.LEDGER_API_KEY = 'l'.repeat(64);
    process.env.WALLET_API_KEY = 't'.repeat(64);
    for (const value of ['q'.repeat(64), 'l'.repeat(64), 't'.repeat(64)]) {
      process.env.EXCHANGE_API_KEY = value;
      assert.throws(() => exchangeApiConfig(), /distinct exchange backend API credential/);
    }
    process.env.EXCHANGE_API_KEY = settings.apiKey;
    assert.deepEqual(exchangeApiConfig(), settings);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
