import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { CustodyCommandsService } from '../apps/wallet/src/custody-api/custody-commands.service.js';
import { ExchangeCustomersService } from '../apps/wallet/src/customers/customers.service.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { WalletWorkflowService } from '../apps/wallet/src/messaging/wallet-workflow.service.js';
import { TransactionsService } from '../apps/wallet/src/transactions/transactions.service.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import {
  derivationRequestDigest,
  Message,
  MessageAuth,
  messageSchema,
  QUEUES,
} from '../packages/queue/src/messages.js';
import {
  custodySettings,
  devnet,
  isolatedDatabase,
  testMnemonic,
} from './helpers/custody-fixture.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_LEDGER_DATABASE_URL;
const settings = { domainId: `custody-${randomUUID()}`, apiKey: 'c'.repeat(64) };
const config = custodySettings(settings.domainId);
const auth = new MessageAuth('q'.repeat(64), randomUUID());
const userId = randomUUID();
let db: WalletPrismaService;
let ledgerDb: LedgerPrismaService;
const fixtures: Awaited<ReturnType<typeof isolatedDatabase>>[] = [];
let custody: CustodyService;
let customers: ExchangeCustomersService;
let exchange: ExchangeMessagingService;
let workflow: WalletWorkflowService;
let signer: SigningService;
let registry: ExchangeRegistryService;
let assignmentId: string;
let customerWalletId: string;

function event(
  type: ExchangeEvent['type'],
  aggregateId: string,
  data: unknown,
  customerId?: string,
) {
  return exchangeEventSchema.parse({
    eventId: randomUUID(),
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId: settings.domainId,
    correlationId: aggregateId,
    causationId: null,
    aggregateId,
    revision: 1,
    ...(customerId ? { customerId } : {}),
    type,
    data,
  });
}

async function handle(message: Message, id: string = randomUUID()) {
  const envelope = auth.seal(message, id);
  await workflow.handle(auth.open(envelope, id, message.type), id, false);
}

before(async () => {
  if (!enabled) return;
  const walletFixture = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
  fixtures.push(walletFixture);
  const ledgerFixture = await isolatedDatabase(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
  fixtures.push(ledgerFixture);
  db = new WalletPrismaService({ databaseUrl: walletFixture.url });
  ledgerDb = new LedgerPrismaService({ databaseUrl: ledgerFixture.url });
  registry = new ExchangeRegistryService(ledgerDb);
  custody = new CustodyService(db, config, settings, auth);
  customers = new ExchangeCustomersService(
    db,
    settings,
    auth,
    {
      exchangeBalances: (domainId: string, customerId: string) =>
        registry.balances(domainId, customerId),
    } as unknown as LedgerClient,
    custody,
  );
  exchange = new ExchangeMessagingService(db, auth, customers);
  workflow = new WalletWorkflowService(
    db,
    {} as ChainRpcService,
    config,
    exchange,
    custody,
    customers,
    auth,
  );
  signer = new SigningService(
    await SigningCore.create(testMnemonic, config.seedId, config.ethereumChainId, undefined, {
      domainId: settings.domainId,
      chainNetworks: {
        ethereum: { network: '11155111', chainId: '11155111' },
        bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
        solana: { network: devnet, genesisHash: devnet },
      },
    }),
  );
});
after(async () => {
  signer?.onApplicationShutdown();
  await db?.$disconnect();
  await ledgerDb?.$disconnect();
  for (const fixture of fixtures.reverse()) await fixture.drop();
});

test(
  'User registration and assignment queue before bootstrap without publishing an address or liability',
  { skip: !enabled },
  async () => {
    await exchange.handle(event('user.registered.v1', userId, { userId }, userId));
    const intent = await customers.assign(userId, 'ethereum', '11155111');
    assignmentId = intent.assignmentId;
    assert.equal(intent.state, 'waiting');
    assert.equal('address' in intent, false);
    const issue = await db.outbox.findFirstOrThrow({
      where: { dedupe_key: `assignment-issue-${assignmentId}` },
    });
    assert.equal(issue.queue, QUEUES.wallet);
    await assert.rejects(() => handle(messageSchema.parse(issue.payload)), /bootstrap/);
    assert.equal(await db.wallet.count(), 0);
    const registration = await db.outbox.findFirstOrThrow({ where: { queue: QUEUES.ledger } });
    await registry.handle(exchangeEventSchema.parse(registration.payload));
    for (const reply of await ledgerDb.outbox.findMany())
      await exchange.handle(exchangeEventSchema.parse(reply.payload));
    const balances = await customers.balances(userId);
    assert.ok('balances' in balances);
    assert.deepEqual(balances.balances, []);
    assert.equal(await ledgerDb.ledgerEntry.count(), 0);
  },
);

test(
  'replica bootstrap is idempotent, reserves only hot0 and approved management1, and repairs pending issuance',
  { skip: !enabled },
  async () => {
    const replica = new CustodyService(db, config, settings, auth);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? custody : replica).bootstrap()),
    );
    assert.equal(new Set(results.map((r) => r.hotWallets.map((w) => w.id).join(','))).size, 1);
    assert.equal(await db.wallet.count(), 5);
    assert.equal(await db.wallet.count({ where: { account: { gte: 2, lte: 9 } } }), 0);
    assert.equal(await db.outbox.count({ where: { queue: QUEUES.signer } }), 5);
    const commands = new CustodyCommandsService(db, custody, settings, auth);
    const queued = await commands.bootstrap();
    const command = await db.outbox.findFirstOrThrow({
      where: { dedupe_key: `custody-${queued.commandId}` },
    });
    await handle(messageSchema.parse(command.payload), command.id);
    await handle(messageSchema.parse(command.payload), command.id);
    assert.equal(
      await db.outbox.count({
        where: { dedupe_key: `assignment-issue-${assignmentId}-${queued.commandId}` },
      }),
      1,
    );
  },
);

test(
  'concurrent address issuance allocates the first customer account10 once',
  { skip: !enabled },
  async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => customers.issueAssignment(assignmentId, settings.domainId)),
    );
    const row = await db.exchangeDepositAddressAssignment.findUniqueOrThrow({
      where: { assignment_id: assignmentId },
    });
    customerWalletId = row.wallet_id!;
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: customerWalletId } });
    assert.equal(wallet.account, 10);
    assert.equal(wallet.customer_id, userId);
    assert.equal(wallet.path, "m/44'/60'/10'/0/0");
    assert.equal(await db.wallet.count({ where: { customer_id: userId } }), 1);
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `derive-${wallet.derivation_request_id}` } }),
      1,
    );
    assert.equal('address' in (await customers.assignment(userId, assignmentId)), false);
  },
);

test(
  'Wallet rejects correctly authenticated signer results with a mismatched immutable derivation binding',
  { skip: !enabled },
  async () => {
    const request = messageSchema.parse(
      (
        await db.outbox.findFirstOrThrow({
          where: { payload: { path: ['walletId'], equals: customerWalletId } },
        })
      ).payload,
    );
    const result = signer.execute(request);
    assert.ok(result.type === 'wallet.derived');
    for (const patch of [
      { requestId: randomUUID() },
      { domainId: 'other-domain' },
      { network: '1' },
      { path: "m/44'/60'/11'/0/0" },
      { request: { ...result.request, seedId: 'other-seed' } },
      { request: { ...result.request, account: 11 } },
    ]) {
      const changed = { ...result, ...patch };
      changed.requestDigest = derivationRequestDigest(changed);
      const id = randomUUID();
      await assert.rejects(() => handle(changed, id), /derivation/i);
      assert.equal(await db.inbox.count({ where: { id } }), 0);
    }
    await assert.rejects(() => handle({ ...result, address: 'invalid' }), /invalid chain address/);
    assert.equal(
      (await db.wallet.findUniqueOrThrow({ where: { id: customerWalletId } })).status,
      'deriving',
    );
    assert.equal(await db.exchangeWalletRegistry.count(), 0);
  },
);

test(
  'derivation and registry publication commit atomically and replay fans out once per consumer',
  { skip: !enabled },
  async () => {
    const requests = await db.outbox.findMany({ where: { queue: QUEUES.signer } });
    for (const request of requests) {
      const result = signer.execute(messageSchema.parse(request.payload));
      await handle(result);
      await handle(result);
    }
    assert.equal(
      await db.wallet.count({ where: { published_at: { not: null }, status: 'ready' } }),
      6,
    );
    assert.equal(await db.exchangeWalletRegistry.count(), 6);
    const deliveries = await db.outbox.findMany({
      where: { payload: { path: ['data', 'walletId'], equals: customerWalletId } },
    });
    assert.deepEqual(
      deliveries.map((d) => d.queue).sort(),
      [QUEUES.activity, QUEUES.ledger, QUEUES.sweep].sort(),
    );
    assert.equal(new Set(deliveries.map((d) => d.dedupe_key)).size, 3);
    assert.equal('address' in (await customers.assignment(userId, assignmentId)), false);
  },
);

test(
  'customer address waits for registered hot0, management1 and listener backfill coverage',
  { skip: !enabled },
  async () => {
    const requests = (await db.outbox.findMany({ where: { queue: QUEUES.ledger } })).map((row) =>
      exchangeEventSchema.parse(row.payload),
    );
    const customer = requests.find((e) => e.type === 'customer-wallet.registry.requested.v1')!;
    await assert.rejects(() => registry.handle(customer), /hot wallet has not arrived/);
    for (const request of requests.filter((e) => e.type === 'custody-wallet.registry.requested.v1'))
      await registry.handle(request);
    await registry.handle(customer);
    for (const reply of await ledgerDb.outbox.findMany())
      await exchange.handle(exchangeEventSchema.parse(reply.payload));
    assert.equal('address' in (await customers.assignment(userId, assignmentId)), false);
    await exchange.handle(
      event(
        'customer-wallet.registry.acknowledged.v1',
        customerWalletId,
        {
          walletId: customerWalletId,
          registryRevision: 1,
          consumer: 'activity-listener',
          status: 'ready',
          coverageComplete: true,
          backfillCursor: 'certified-fixture-block-1',
        },
        userId,
      ),
    );
    const ready = await customers.assignment(userId, assignmentId);
    assert.ok(ready.state === 'ready');
    assert.equal(ready.walletId, customerWalletId);
    const balances = await customers.balances(userId);
    assert.ok('balances' in balances);
    assert.deepEqual(balances.balances, []);
    await assert.rejects(() => customers.assignment(randomUUID(), assignmentId), /not found/i);
  },
);

test(
  'database constraints preserve reserved roles, ownership, pinned configuration and published identities',
  { skip: !enabled },
  async () => {
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: customerWalletId } });
    for (const data of [
      { account: 9 },
      { path: "m/0'" },
      { customer_id: randomUUID() },
      { network: '1' },
      { seed_id: 'another-seed' },
      { address: '0x' + '1'.repeat(40) },
      { registry_revision: 0 },
      { published_at: null },
    ])
      await assert.rejects(() => db.wallet.update({ where: { id: wallet.id }, data }));
    await assert.rejects(
      () => db.wallet.delete({ where: { id: wallet.id } }),
      /immutable ownership/,
    );
    await assert.rejects(
      () =>
        db.custodyDomain.update({ where: { id: settings.domainId }, data: { seed_id: 'another' } }),
      /immutable/,
    );
    await assert.rejects(
      () =>
        db.assetConfiguration.delete({
          where: {
            domain_id_chain_network_asset_id: {
              domain_id: settings.domainId,
              chain: 'ethereum',
              network: '11155111',
              asset_id: 'token:ethereum:native',
            },
          },
        }),
      /immutable policy/,
    );
    await assert.rejects(() =>
      db.exchangeCustomer.update({
        where: { customer_id: userId },
        data: { domain_id: 'another' },
      }),
    );
    await assert.rejects(
      () =>
        db.assetConfiguration.update({
          where: {
            domain_id_chain_network_asset_id: {
              domain_id: settings.domainId,
              chain: 'ethereum',
              network: '11155111',
              asset_id: 'token:ethereum:native',
            },
          },
          data: { decimals: 6 },
        }),
      /immutable/,
    );
    const { created_at: _created, ...copy } = wallet;
    await assert.rejects(() =>
      db.wallet.create({
        data: {
          ...copy,
          id: randomUUID(),
          external_id: randomUUID(),
          account: 9,
          address: null,
          published_at: null,
          registry_revision: 0,
          derivation_request_id: randomUUID(),
        },
      }),
    );
    const hot = await db.wallet.findFirstOrThrow({
      where: { chain: 'ethereum', custody_role: 'hot' },
    });
    await assert.rejects(() =>
      db.wallet.create({
        data: {
          ...copy,
          id: randomUUID(),
          external_id: randomUUID(),
          custody_role: 'hot',
          account: 0,
          customer_id: null,
          hot_wallet_id: null,
          address: null,
          published_at: null,
          registry_revision: 0,
          derivation_request_id: randomUUID(),
          path: hot.path,
        },
      }),
    );
  },
);

test(
  'paused custody, disabled assets and changed signer seed keep existing addresses unavailable',
  { skip: !enabled },
  async () => {
    await db.custodyDomain.update({ where: { id: settings.domainId }, data: { status: 'paused' } });
    assert.equal('address' in (await customers.assignment(userId, assignmentId)), false);
    await db.custodyDomain.update({ where: { id: settings.domainId }, data: { status: 'active' } });
    const asset = {
      domain_id: settings.domainId,
      chain: 'ethereum',
      network: '11155111',
      asset_id: 'token:ethereum:native',
    };
    await db.assetConfiguration.update({
      where: { domain_id_chain_network_asset_id: asset },
      data: { credit_enabled: false },
    });
    assert.equal('address' in (await customers.assignment(userId, assignmentId)), false);
    await db.assetConfiguration.update({
      where: { domain_id_chain_network_asset_id: asset },
      data: { credit_enabled: true },
    });
    const changed = new ExchangeCustomersService(
      db,
      settings,
      auth,
      {} as LedgerClient,
      new CustodyService(db, { ...config, seedId: 'other-seed' }, settings, auth),
    );
    assert.equal('address' in (await changed.assignment(userId, assignmentId)), false);
    assert.equal((await customers.assignment(userId, assignmentId)).state, 'ready');
  },
);

test(
  'different customer replicas allocate unique accounts above the reserved range',
  { skip: !enabled },
  async () => {
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => customers.create(`replica-${settings.domainId}-${i}`)),
    );
    const wallets = await Promise.all(
      users.map((u) =>
        db.$transaction((tx) => custody.allocateCustomer(tx, u.customerId, 'bitcoin', 'regtest')),
      ),
    );
    assert.equal(new Set(wallets.map((w) => w.account)).size, 8);
    assert.ok(wallets.every((w) => w.account >= 11 && w.path.startsWith("m/84'/1'/")));
    await assert.rejects(
      () =>
        custody.bootstrap.call(
          new CustodyService(db, { ...config, seedId: 'changed' }, settings, auth),
        ),
      /immutable/,
    );
    assert.throws(() => custody.validateNetwork('bitcoin', 'mainnet'), /regtest/);
    await assert.rejects(() => customers.issueAssignment(assignmentId, 'other-domain'), /domain/);
  },
);

test(
  'unapproved management accounts and generic custody transfers cannot bypass exchange execution policy',
  { skip: !enabled },
  async () => {
    for (const [chain, network, account] of [
      ['ethereum', '11155111', 2],
      ['bitcoin', 'regtest', 1],
    ] as const)
      await assert.rejects(
        () => db.$transaction((tx) => custody.createManagement(tx, chain, network, account)),
        /approved purpose/,
      );
    const transactions = new TransactionsService(db, config);
    await assert.rejects(
      () =>
        transactions.createTransaction(customerWalletId, randomUUID(), {
          chain: 'ethereum',
          to: '0x' + '1'.repeat(40),
          amount: '1',
          maxFeePerGas: '1',
          maxPriorityFeePerGas: '1',
        }),
      /authorized sweep or withdrawal/,
    );
    assert.equal(await db.transaction.count(), 0);
  },
);

test(
  'custody commands from a retired reset epoch are rejected before mutation',
  { skip: !enabled },
  async () => {
    const message: Message = {
      type: 'custody.bootstrap',
      domainId: settings.domainId,
      commandId: randomUUID(),
    };
    const old = new MessageAuth('q'.repeat(64), 'retired-epoch').seal(message);
    assert.throws(() => auth.open(old, old.id, message.type), /epoch/i);
  },
);

test(
  'noncycling allocator accepts the final hardened account and reports exhaustion clearly',
  { skip: !enabled },
  async () => {
    await db.$queryRaw`SELECT setval('wallets_account_seq', 2147483647, false)`;
    assert.equal(await db.$transaction((tx) => custody.allocateCustomerAccount(tx)), 2147483647);
    await assert.rejects(
      () => db.$transaction((tx) => custody.allocateCustomerAccount(tx)),
      /range is exhausted/,
    );
  },
);
