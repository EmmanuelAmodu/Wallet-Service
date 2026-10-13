import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActivityPrismaService } from '../apps/activity-listener/src/prisma/prisma.service.js';
import { ActivityRegistryService } from '../apps/activity-listener/src/registry/registry.service.js';
import {
  HttpExchangeWatchProvider,
  RoutingExchangeWatchProvider,
} from '../apps/activity-listener/src/provider/provider.service.js';
import { exchangeProviderConfig } from '../apps/activity-listener/src/config/activity-provider.config.js';
import {
  ExchangeWatchProvider,
  ProviderInstallRequest,
  ProviderInstallAcknowledgment,
  ProviderBackfillRequest,
  ProviderBackfillPage,
  ProviderRemoveRequest,
  ProviderWatchIdentity,
  ProviderCertification,
  providerCertificationSchema,
} from '../apps/activity-listener/src/provider/provider.contracts.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { migrate } from '../scripts/migrate.js';

const certificate: ProviderCertification = {
  provider: 'quicknode',
  chain: 'ethereum',
  network: '11155111',
  assetScope: 'native',
  watchInstall: true,
  watchRemove: true,
  backfill: true,
  stableTransferIdentity: true,
  rawUnits: true,
  resetEpochDelivery: true,
  nativeTraceCoverage: true,
};

function identity(request: ProviderWatchIdentity): ProviderWatchIdentity {
  const {
    protocolVersion,
    provider,
    domainId,
    resetEpoch,
    walletId,
    registryRevision,
    generation,
    chain,
    network,
    address,
    assetScope,
  } = request;
  return {
    protocolVersion,
    provider,
    domainId,
    resetEpoch,
    walletId,
    registryRevision,
    generation,
    chain,
    network,
    address,
    assetScope,
  };
}

function page(
  request: ProviderBackfillRequest,
  overrides: Partial<ProviderBackfillPage> = {},
): ProviderBackfillPage {
  return {
    ...identity(request),
    watchId: request.watchId,
    fromCursor: request.fromCursor,
    throughCursor: request.throughCursor,
    cursor: request.throughCursor,
    complete: true,
    transactionHashes: [],
    ...overrides,
  };
}

class FixtureProvider implements ExchangeWatchProvider {
  readonly name = 'quicknode';
  enabled = true;
  installs: ProviderInstallRequest[] = [];
  backfills: ProviderBackfillRequest[] = [];
  removals: ProviderRemoveRequest[] = [];
  onInstall?: (request: ProviderInstallRequest) => Promise<ProviderInstallAcknowledgment>;
  onBackfill?: (request: ProviderBackfillRequest) => Promise<ProviderBackfillPage>;
  onRemove?: (request: ProviderRemoveRequest) => Promise<void>;
  certified(chain: string, network: string) {
    return this.enabled && chain === 'ethereum' && network === '11155111';
  }

  async install(request: ProviderInstallRequest) {
    this.installs.push(request);
    if (this.onInstall) return this.onInstall(request);
    return {
      ...identity(request),
      status: 'installed' as const,
      watchId: `watch-${request.generation}`,
      startCursor: '100',
    };
  }

  async backfill(request: ProviderBackfillRequest) {
    this.backfills.push(request);
    return this.onBackfill ? this.onBackfill(request) : page(request);
  }

  async remove(request: ProviderRemoveRequest) {
    this.removals.push(request);
    await this.onRemove?.(request);
    return { ...identity(request), watchId: request.watchId, status: 'removed' as const };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const enabled = !!process.env.TEST_ACTIVITY_DATABASE_URL;
const db = enabled
  ? new ActivityPrismaService({ databaseUrl: process.env.TEST_ACTIVITY_DATABASE_URL! })
  : undefined;
const domainId = `provider-registry-${randomUUID()}`;
const domains = new Set([domainId]);
const auth = new MessageAuth('a'.repeat(64), 'provider-registry-test');
const ids: string[] = [];
type Registration = Extract<ExchangeEvent, { type: 'customer-wallet.registry.requested.v1' }>;

function registration(
  extra: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Registration {
  const event = exchangeEventSchema.parse({
    eventId: randomUUID(),
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId,
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision: 1,
    customerId: randomUUID(),
    type: 'customer-wallet.registry.requested.v1',
    data: {
      walletId: randomUUID(),
      chain: 'ethereum',
      network: '11155111',
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
      hotWalletId: randomUUID(),
      account: 10,
      registryRevision: 1,
      startCursor: '50',
      ...data,
    },
    ...extra,
  });
  ids.push(event.eventId);
  domains.add(event.domainId);
  return event as Registration;
}

async function ensureCustody(request: Registration, includeManagement = true, registryAuth = auth) {
  const service = new ActivityRegistryService(db!, registryAuth);
  const registry = (role: 'hot' | 'management', walletId: string, account: number) => {
    const event = exchangeEventSchema.parse({
      ...request,
      eventId: randomUUID(),
      customerId: undefined,
      type: 'custody-wallet.registry.requested.v1',
      data: {
        walletId,
        chain: request.data.chain,
        network: request.data.network,
        address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
        role,
        account,
        registryRevision: 1,
      },
    });
    ids.push(event.eventId);
    return event as Extract<ExchangeEvent, { type: 'custody-wallet.registry.requested.v1' }>;
  };
  if (
    !(await db!.exchangeWalletRegistration.findUnique({
      where: { wallet_id: request.data.hotWalletId },
    }))
  )
    await service.register(registry('hot', request.data.hotWalletId, 0));
  if (
    includeManagement &&
    !(await db!.exchangeWalletRegistration.findFirst({
      where: {
        domain_id: request.domainId,
        chain: request.data.chain,
        network: request.data.network,
        role: 'management',
        account: 1,
      },
    }))
  )
    await service.register(registry('management', randomUUID(), 1));
}

async function row(id: string) {
  return db!.exchangeWalletRegistration.findUniqueOrThrow({ where: { wallet_id: id } });
}

async function acks(id: string) {
  const deliveries = await db!.outbox.findMany({
    where: { queue: QUEUES.wallet, payload: { path: ['data', 'walletId'], equals: id } },
  });
  return deliveries
    .map((delivery) => exchangeEventSchema.parse(delivery.payload))
    .sort((a, b) => a.revision - b.revision);
}

before(async () => {
  if (enabled) await migrate(process.env.TEST_ACTIVITY_DATABASE_URL!, 'activity');
});
after(async () => {
  if (!enabled) return;
  const wallets = await db!.exchangeWalletRegistration.findMany({
    where: { domain_id: { in: [...domains] } },
    select: { wallet_id: true },
  });
  await db!.outbox.deleteMany({
    where: {
      OR: [
        ...[...domains].map((value) => ({ payload: { path: ['domainId'], equals: value } })),
        ...wallets.map((wallet) => ({
          payload: { path: ['discovery', 'walletId'], equals: wallet.wallet_id },
        })),
      ],
    },
  });
  await db!.inbox.deleteMany({ where: { id: { in: ids.map((id) => `activity-listener:${id}`) } } });
  await db!.exchangeProviderWatchLease.deleteMany({ where: { domain_id: { in: [...domains] } } });
  await db!.exchangeWalletRegistration.deleteMany({ where: { domain_id: { in: [...domains] } } });
  await db!.$disconnect();
});

test('selected QuickNode gateway stays disabled until exact network and trace capabilities are certified', () => {
  const disabled = new HttpExchangeWatchProvider(exchangeProviderConfig({}));
  assert.equal(disabled.name, 'quicknode');
  assert.equal(disabled.certified('ethereum', '11155111'), false);
  const provider = new HttpExchangeWatchProvider({
    name: 'quicknode',
    url: 'https://provider.example',
    apiKey: 'separate-gateway-key',
    certifications: [certificate],
    nativeTraceMode: 'callTracer',
  });
  assert.equal(provider.certified('ethereum', '11155111'), true);
  assert.equal(provider.certified('ethereum', '1'), false);
  assert.equal(provider.certified('solana', 'devnet'), false);
  assert.equal(provider.certified('bitcoin', 'regtest'), false);
  const topLevel = new HttpExchangeWatchProvider({
    name: 'quicknode',
    url: 'https://provider.example',
    apiKey: 'key',
    certifications: [certificate],
  });
  assert.equal(topLevel.certified('ethereum', '11155111'), false);
  assert.equal(
    providerCertificationSchema.safeParse({ ...certificate, nativeTraceCoverage: undefined })
      .success,
    false,
  );
  assert.equal(
    providerCertificationSchema.safeParse({ ...certificate, assetScope: 'spl' }).success,
    false,
  );
  assert.throws(
    () =>
      new HttpExchangeWatchProvider({
        name: 'quicknode',
        url: 'http://provider.example',
        apiKey: 'key',
        certifications: [],
      }),
    /HTTPS/,
  );
});

test('QuickNode gateway HTTP protocol separates bearer credentials and fences idempotent install/backfill/removal', async () => {
  const calls: { url: string; headers: Headers; request: unknown }[] = [];
  const fetcher = (async (url, options) => {
    const request = JSON.parse(String(options!.body)) as ProviderInstallRequest &
      ProviderBackfillRequest &
      ProviderRemoveRequest;
    calls.push({ url: String(url), headers: new Headers(options!.headers), request });
    const result = String(url).endsWith('/install')
      ? { ...identity(request), status: 'installed', watchId: 'qn-stream-id', startCursor: '100' }
      : String(url).endsWith('/backfill')
        ? page(request)
        : { ...identity(request), watchId: request.watchId, status: 'removed' };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const provider = new HttpExchangeWatchProvider(
    {
      name: 'quicknode',
      url: 'https://provider.example/gateway',
      apiKey: 'gateway-credential',
      certifications: [certificate],
      nativeTraceMode: 'callTracer',
    },
    fetcher,
  );
  const request: ProviderInstallRequest = {
    protocolVersion: 1,
    provider: 'quicknode',
    domainId: 'domain',
    resetEpoch: 'epoch',
    walletId: randomUUID(),
    registryRevision: 2,
    generation: randomUUID(),
    chain: 'ethereum',
    network: '11155111',
    address: '0x' + '12'.repeat(20),
    assetScope: 'native',
    fromCursor: '50',
  };
  const installed = await provider.install(request);
  await provider.install(request);
  await provider.backfill({
    ...identity(request),
    watchId: installed.watchId,
    fromCursor: '50',
    throughCursor: installed.startCursor,
  });
  await provider.remove({ ...identity(request), watchId: installed.watchId });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://provider.example/gateway/v1/watches/install');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer gateway-credential');
  assert.equal(calls[0].headers.get('x-api-key'), null);
  assert.equal(calls[0].headers.get('idempotency-key'), calls[1].headers.get('idempotency-key'));
  assert.notEqual(calls[0].headers.get('idempotency-key'), calls[2].headers.get('idempotency-key'));
  await assert.rejects(
    () => provider.install({ ...request, provider: 'bitcoin-core' }),
    /not certified/,
  );
});

test(
  'provider installation and every backfill discovery commit before readiness; same revision replay preserves readiness',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const entered = deferred<void>();
    const finish = deferred<void>();
    provider.onBackfill = async (request) => {
      if (request.fromCursor === '50')
        return page(request, {
          complete: false,
          cursor: '75',
          transactionHashes: ['0x' + '11'.repeat(32)],
        });
      entered.resolve();
      await finish.promise;
      return page(request, { transactionHashes: ['0x' + '22'.repeat(32)] });
    };
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    const running = service.register(request);
    await entered.promise;
    const intermediate = await row(request.data.walletId);
    assert.equal(intermediate.status, 'backfilling');
    assert.equal(intermediate.backfill_cursor, '75');
    assert.equal(intermediate.backfill_complete, false);
    assert.equal(intermediate.provider_watch_id, `watch-${intermediate.provider_generation}`);
    assert.equal(
      (await acks(request.data.walletId)).some(
        (ack) =>
          ack.type === 'customer-wallet.registry.acknowledged.v1' && ack.data.status === 'ready',
      ),
      false,
    );
    assert.equal(
      await db!.outbox.count({
        where: { payload: { path: ['discovery', 'walletId'], equals: request.data.walletId } },
      }),
      1,
    );
    finish.resolve();
    await running;
    const ready = await row(request.data.walletId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.start_cursor, '100');
    assert.equal(ready.coverage_start_cursor, '50');
    assert.equal(ready.backfill_cursor, '100');
    assert.equal(ready.backfill_complete, true);
    assert.equal(ready.readiness_revision, 2);
    assert.equal(
      await db!.outbox.count({
        where: { payload: { path: ['discovery', 'walletId'], equals: request.data.walletId } },
      }),
      2,
    );
    await ensureCustody(request);
    await service.register(request);
    const replay = registration(
      { customerId: request.customerId, aggregateId: request.aggregateId },
      request.data,
    );
    await service.register(replay);
    assert.equal((await row(request.data.walletId)).status, 'ready');
    assert.equal((await row(request.data.walletId)).readiness_revision, 2);
    assert.equal(provider.installs.length, 1);
    assert.equal(provider.backfills.length, 2);
  },
);

test(
  'backfill outage pauses readiness and resumes from its durable cursor without reinstalling',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    let fail = true;
    provider.onBackfill = async (request) => {
      if (request.fromCursor === '50')
        return page(request, {
          complete: false,
          cursor: '75',
          transactionHashes: ['0x' + '33'.repeat(32)],
        });
      if (fail) throw new Error('simulated provider outage');
      return page(request);
    };
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    await assert.rejects(() => service.register(request), /simulated provider outage/);
    const paused = await row(request.data.walletId);
    assert.equal(paused.status, 'awaiting_provider_coverage');
    assert.equal(paused.backfill_cursor, '75');
    assert.equal(paused.backfill_complete, false);
    assert.equal(paused.readiness_revision, 2);
    fail = false;
    await service.recoverPending();
    const ready = await row(request.data.walletId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.readiness_revision, 3);
    assert.equal(provider.installs.length, 1);
    assert.deepEqual(
      provider.backfills.map((call) => call.fromCursor),
      ['50', '75', '75'],
    );
  },
);

test(
  'wrong domain, reset epoch, registry revision or provider acknowledgment never opens readiness',
  { skip: !enabled },
  async () => {
    for (const mismatch of [
      { domainId: 'other' },
      { resetEpoch: 'old' },
      { registryRevision: 2 },
      { provider: 'bitcoin-core' as const },
    ]) {
      const provider = new FixtureProvider();
      provider.onInstall = async (request) => ({
        ...identity(request),
        ...mismatch,
        status: 'installed',
        watchId: 'bad-watch',
        startCursor: '100',
      });
      const service = new ActivityRegistryService(db!, auth, provider);
      const request = registration();
      await assert.rejects(() => service.register(request), /identity mismatch/);
      const failed = await row(request.data.walletId);
      assert.equal(failed.status, 'awaiting_provider_coverage');
      assert.equal(failed.provider_watch_id, null);
      assert.equal(failed.backfill_complete, false);
      assert.equal(
        (await acks(request.data.walletId)).some(
          (ack) =>
            ack.type === 'customer-wallet.registry.acknowledged.v1' && ack.data.status === 'ready',
        ),
        false,
      );
    }
  },
);

test(
  'registry rebuild pauses readiness, removes the old watch and closes the gap from prior durable coverage',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    await service.register(request);
    const before = await row(request.data.walletId);
    let unavailable = true;
    provider.onRemove = async () => {
      if (unavailable) throw new Error('remove unavailable');
    };
    await assert.rejects(() => service.rebuild(request.data.walletId), /remove unavailable/);
    const paused = await row(request.data.walletId);
    assert.equal(paused.status, 'rebuilding');
    assert.equal(paused.backfill_complete, false);
    assert.equal(paused.coverage_start_cursor, '100');
    assert.ok(paused.readiness_revision > before.readiness_revision);
    const rejection = (await acks(request.data.walletId)).at(-1)!;
    assert.equal(rejection.type, 'customer-wallet.registry.acknowledged.v1');
    if (rejection.type !== 'customer-wallet.registry.acknowledged.v1')
      throw new Error('Unexpected ack');
    assert.equal(rejection.data.status, 'rejected');
    unavailable = false;
    await service.recover(request.data.walletId);
    const after = await row(request.data.walletId);
    assert.equal(after.status, 'ready');
    assert.notEqual(after.provider_generation, before.provider_generation);
    assert.equal(provider.removals[0].generation, before.provider_generation);
    assert.equal(provider.installs.at(-1)!.fromCursor, '100');
    assert.ok(after.readiness_revision > paused.readiness_revision);
  },
);

test(
  'higher registry revisions rebuild with fenced removal; stale events and removal replay cannot reinstall',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const first = registration();
    await ensureCustody(first);
    await service.register(first);
    const second = registration(
      { customerId: first.customerId, aggregateId: first.aggregateId, revision: 2 },
      { ...first.data, registryRevision: 2 },
    );
    await service.register(second);
    const current = await row(first.data.walletId);
    assert.equal(current.registry_revision, 2);
    assert.equal(current.status, 'ready');
    assert.equal(provider.removals[0].registryRevision, 1);
    assert.equal(provider.installs[1].registryRevision, 2);
    const stale = registration(
      { customerId: first.customerId, aggregateId: first.aggregateId },
      first.data,
    );
    await service.register(stale);
    assert.equal((await row(first.data.walletId)).registry_revision, 2);
    await service.remove(first.data.walletId);
    await service.remove(first.data.walletId);
    await service.register(second);
    assert.equal((await row(first.data.walletId)).status, 'removed');
    assert.equal(provider.installs.length, 2);
    assert.equal(provider.removals.length, 2);
  },
);

test(
  'custody wallet projections never install provider subscriptions and database guards require real customer coverage',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const customer = registration();
    const custody = exchangeEventSchema.parse({
      ...customer,
      eventId: randomUUID(),
      customerId: undefined,
      type: 'custody-wallet.registry.requested.v1',
      data: {
        walletId: randomUUID(),
        chain: 'ethereum',
        network: '11155111',
        address: '0x' + 'ff'.repeat(20),
        role: 'hot',
        account: 0,
        registryRevision: 1,
      },
    });
    if (custody.type !== 'custody-wallet.registry.requested.v1')
      throw new Error('Unexpected custody event');
    ids.push(custody.eventId);
    await service.register(
      custody as Extract<ExchangeEvent, { type: 'custody-wallet.registry.requested.v1' }>,
    );
    assert.equal(provider.installs.length, 0);
    assert.equal((await row(custody.data.walletId)).status, 'ready');
    await new ActivityRegistryService(db!, auth).register(customer);
    await assert.rejects(
      () =>
        db!.exchangeWalletRegistration.update({
          where: { wallet_id: customer.data.walletId },
          data: { status: 'ready', backfill_complete: true, backfill_cursor: '100' },
        }),
      /constraint/i,
    );
    await assert.rejects(() => service.remove(custody.data.walletId), /Custody projections/);
  },
);

test(
  'malformed backfill range is rejected and cannot certify readiness',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    provider.onBackfill = async (request) => page(request, { throughCursor: '999' });
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await assert.rejects(() => service.register(request), /coverage range/);
    assert.equal((await row(request.data.walletId)).status, 'awaiting_provider_coverage');
    assert.equal((await row(request.data.walletId)).backfill_complete, false);
  },
);

test(
  'hot0 and management1 registry lag keeps customer coverage readiness closed until both arrive',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration({ domainId: `${domainId}-custody-lag` });
    await assert.rejects(() => service.register(request), /Hot custody registry/);
    assert.equal((await row(request.data.walletId)).status, 'awaiting_provider_coverage');
    await ensureCustody(request, false);
    await assert.rejects(
      () => service.recover(request.data.walletId),
      /Management1 custody registry/,
    );
    assert.equal((await row(request.data.walletId)).backfill_complete, false);
    await ensureCustody(request);
    await service.recover(request.data.walletId);
    assert.equal((await row(request.data.walletId)).status, 'ready');
    const history = await acks(request.data.walletId);
    assert.equal(
      history.filter(
        (event) =>
          event.type === 'customer-wallet.registry.acknowledged.v1' &&
          event.data.status === 'ready',
      ).length,
      1,
    );
  },
);

test(
  'withdrawing certification invalidates ready addresses and recovery closes the delivery gap',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    await service.register(request);
    const initial = await row(request.data.walletId);
    provider.enabled = false;
    await service.recoverPending();
    const paused = await row(request.data.walletId);
    assert.equal(paused.status, 'rebuilding');
    assert.equal(paused.backfill_complete, false);
    assert.ok(paused.readiness_revision > initial.readiness_revision);
    provider.enabled = true;
    await service.recover(request.data.walletId);
    const ready = await row(request.data.walletId);
    assert.equal(ready.status, 'ready');
    assert.notEqual(ready.provider_generation, initial.provider_generation);
    assert.equal(provider.installs.at(-1)!.fromCursor, initial.backfill_cursor);
  },
);

test(
  'late watch installation after a concurrent rebuild is durably cleaned without regressing readiness',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    const started = deferred<ProviderInstallRequest>();
    const finish = deferred<void>();
    let initial = true;
    provider.onInstall = async (install) => {
      if (initial) {
        initial = false;
        started.resolve(install);
        await finish.promise;
      }
      return {
        ...identity(install),
        status: 'installed',
        watchId: `watch-${install.generation}`,
        startCursor: '100',
      };
    };
    const running = service.register(request);
    const old = await started.promise;
    await service.rebuild(request.data.walletId);
    const rebuilt = await row(request.data.walletId);
    assert.equal(rebuilt.status, 'ready');
    assert.notEqual(rebuilt.provider_generation, old.generation);
    finish.resolve();
    await running;
    const after = await row(request.data.walletId);
    assert.equal(after.provider_generation, rebuilt.provider_generation);
    assert.equal(after.status, 'ready');
    assert.equal(
      (
        await db!.exchangeProviderWatchLease.findUniqueOrThrow({
          where: { generation: old.generation },
        })
      ).state,
      'cleanup',
    );
    await service.recoverPending();
    assert.equal(
      (
        await db!.exchangeProviderWatchLease.findUniqueOrThrow({
          where: { generation: old.generation },
        })
      ).state,
      'removed',
    );
    assert.ok(provider.removals.some((call) => call.generation === old.generation));
    assert.equal(
      (await row(request.data.walletId)).provider_generation,
      rebuilt.provider_generation,
    );
  },
);

test(
  'disabled-network batches cannot starve certified recovery or watch cleanup across certificate changes',
  { skip: !enabled },
  async () => {
    const recoveryAuth = new MessageAuth('a'.repeat(64), `fair-recovery-${randomUUID()}`);
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, recoveryAuth, provider);
    const pausedService = new ActivityRegistryService(db!, recoveryAuth);
    const disabled = [];
    for (let index = 0; index < 3; index++) {
      const request = registration(
        { domainId: `${domainId}-fair-recovery`, resetEpoch: recoveryAuth.resetEpoch },
        { chain: 'bitcoin', network: 'regtest', address: `bcrt1qpaused${index}${randomUUID()}` },
      );
      await pausedService.register(request);
      await db!.exchangeWalletRegistration.update({
        where: { wallet_id: request.data.walletId },
        data: { updated_at: new Date(1000 + index) },
      });
      disabled.push(request);
    }
    const enabledRequest = registration({
      domainId: `${domainId}-fair-recovery`,
      resetEpoch: recoveryAuth.resetEpoch,
    });
    await ensureCustody(enabledRequest, true, recoveryAuth);
    let unavailable = true;
    provider.onInstall = async (request) => {
      if (unavailable) throw new Error('temporary install outage');
      return {
        ...identity(request),
        status: 'installed',
        watchId: `watch-${request.generation}`,
        startCursor: '100',
      };
    };
    await assert.rejects(service.register(enabledRequest), /temporary install outage/);
    const cleanup = async (
      request: Registration,
      selected: 'quicknode' | 'bitcoin-core',
      date: number,
    ) => {
      const generation = randomUUID();
      const installRequest: ProviderInstallRequest = {
        protocolVersion: 1,
        provider: selected,
        domainId: request.domainId,
        resetEpoch: recoveryAuth.resetEpoch,
        walletId: request.data.walletId,
        registryRevision: 1,
        generation,
        chain: request.data.chain,
        network: request.data.network,
        address: request.data.address,
        assetScope: 'native',
      };
      await db!.exchangeProviderWatchLease.create({
        data: {
          generation,
          wallet_id: request.data.walletId,
          domain_id: request.domainId,
          reset_epoch: recoveryAuth.resetEpoch,
          provider: selected,
          chain: request.data.chain,
          network: request.data.network,
          install_request: JSON.parse(JSON.stringify(installRequest)),
          state: 'cleanup',
          updated_at: new Date(date),
        },
      });
      return generation;
    };
    const disabledLeases = [];
    for (let index = 0; index < disabled.length; index++)
      disabledLeases.push(await cleanup(disabled[index], 'bitcoin-core', 1000 + index));
    const enabledLease = await cleanup(enabledRequest, 'quicknode', 5000);
    unavailable = false;
    await service.recoverPending(1);
    assert.equal((await row(enabledRequest.data.walletId)).status, 'ready');
    assert.equal(
      (
        await db!.exchangeProviderWatchLease.findUniqueOrThrow({
          where: { generation: enabledLease },
        })
      ).state,
      'removed',
    );
    for (const request of disabled)
      assert.equal((await row(request.data.walletId)).status, 'awaiting_provider_coverage');
    for (const generation of disabledLeases)
      assert.equal(
        (
          await db!.exchangeProviderWatchLease.findUniqueOrThrow({
            where: { generation },
          })
        ).state,
        'cleanup',
      );
    const initial = await row(enabledRequest.data.walletId);
    provider.enabled = false;
    await service.recoverPending(1);
    const revoked = await row(enabledRequest.data.walletId);
    assert.equal(revoked.status, 'rebuilding');
    assert.equal(revoked.backfill_complete, false);
    provider.enabled = true;
    await service.recoverPending(1);
    const restored = await row(enabledRequest.data.walletId);
    assert.equal(restored.status, 'ready');
    assert.notEqual(restored.provider_generation, initial.provider_generation);
    assert.equal(provider.installs.at(-1)!.fromCursor, initial.backfill_cursor);
  },
);

test(
  'lost installation acknowledgment leaves a durable intent that rebuild cleanup can recover',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration();
    await ensureCustody(request);
    let fail = true;
    provider.onInstall = async (install) => {
      if (fail) throw new Error('lost install acknowledgment');
      return {
        ...identity(install),
        status: 'installed',
        watchId: `watch-${install.generation}`,
        startCursor: '100',
      };
    };
    await assert.rejects(() => service.register(request), /lost install/);
    const old = await row(request.data.walletId);
    const lease = await db!.exchangeProviderWatchLease.findUniqueOrThrow({
      where: { generation: old.provider_generation },
    });
    assert.equal(lease.state, 'installing');
    assert.equal(lease.watch_id, null);
    fail = false;
    await service.rebuild(request.data.walletId);
    await service.recoverPending();
    const cleaned = await db!.exchangeProviderWatchLease.findUniqueOrThrow({
      where: { generation: old.provider_generation },
    });
    assert.equal(cleaned.state, 'removed');
    assert.ok(cleaned.watch_id);
    assert.equal((await row(request.data.walletId)).status, 'ready');
  },
);

test('QuickNode Ethereum and Solana gateways run concurrently with an independently certified Bitcoin regtest adapter', async () => {
  const bitcoinCertificate: ProviderCertification = {
    ...certificate,
    provider: 'bitcoin-core',
    chain: 'bitcoin',
    network: 'regtest',
    nativeTraceCoverage: undefined,
  };
  const solanaCertificate: ProviderCertification = {
    ...certificate,
    chain: 'solana',
    network: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    nativeTraceCoverage: undefined,
  };
  const calls: { url: string; authorization: string | null; provider: string }[] = [];
  const fetcher = (async (url, options) => {
    const request = JSON.parse(String(options!.body)) as ProviderInstallRequest &
      ProviderBackfillRequest &
      ProviderRemoveRequest;
    calls.push({
      url: String(url),
      authorization: new Headers(options!.headers).get('authorization'),
      provider: request.provider,
    });
    const result = String(url).endsWith('/install')
      ? {
          ...identity(request),
          status: 'installed',
          watchId: `${request.provider}-watch`,
          startCursor: '100',
        }
      : String(url).endsWith('/backfill')
        ? page(request)
        : { ...identity(request), watchId: request.watchId, status: 'removed' };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const config = exchangeProviderConfig({
    EXCHANGE_PROVIDER_NAME: 'quicknode',
    EXCHANGE_PROVIDER_URL: 'https://quicknode-gateway.example',
    EXCHANGE_PROVIDER_API_KEY: 'quicknode-gateway-key',
    EXCHANGE_PROVIDER_CERTIFICATIONS: JSON.stringify([certificate, solanaCertificate]),
    EXCHANGE_EVM_TRACE_MODE: 'callTracer',
    EXCHANGE_BITCOIN_PROVIDER_URL: 'http://127.0.0.1:8090/bitcoin',
    EXCHANGE_BITCOIN_PROVIDER_API_KEY: 'bitcoin-gateway-key',
    EXCHANGE_BITCOIN_PROVIDER_CERTIFICATIONS: JSON.stringify([bitcoinCertificate]),
  });
  const provider = new RoutingExchangeWatchProvider(config, fetcher);
  assert.equal(provider.certified('ethereum', '11155111'), true);
  assert.equal(provider.certified('solana', solanaCertificate.network), true);
  assert.equal(provider.certified('bitcoin', 'regtest'), true);
  assert.equal(provider.certified('bitcoin', 'mainnet'), false);
  assert.equal(provider.providerFor('ethereum', '11155111'), 'quicknode');
  assert.equal(provider.providerFor('bitcoin', 'regtest'), 'bitcoin-core');
  for (const [chain, network, selected] of [
    ['ethereum', '11155111', 'quicknode'],
    ['solana', solanaCertificate.network, 'quicknode'],
    ['bitcoin', 'regtest', 'bitcoin-core'],
  ] as const) {
    const request: ProviderInstallRequest = {
      protocolVersion: 1,
      provider: selected,
      domainId: 'domain',
      resetEpoch: 'epoch',
      walletId: randomUUID(),
      registryRevision: 1,
      generation: randomUUID(),
      chain,
      network,
      address: 'fixture-address',
      assetScope: 'native',
    };
    const installed = await provider.install(request);
    await provider.backfill({
      ...identity(request),
      watchId: installed.watchId,
      fromCursor: '50',
      throughCursor: '100',
    });
    await provider.remove({ ...identity(request), watchId: installed.watchId });
  }
  assert.equal(calls.length, 9);
  assert.equal(
    calls
      .filter((call) => call.provider === 'quicknode')
      .every(
        (call) =>
          call.url.startsWith('https://quicknode-gateway.example/') &&
          call.authorization === 'Bearer quicknode-gateway-key',
      ),
    true,
  );
  assert.equal(
    calls
      .filter((call) => call.provider === 'bitcoin-core')
      .every(
        (call) =>
          call.url.startsWith('http://127.0.0.1:8090/bitcoin/') &&
          call.authorization === 'Bearer bitcoin-gateway-key',
      ),
    true,
  );
  const bitcoinOnly = new RoutingExchangeWatchProvider(
    { name: 'quicknode', certifications: [], bitcoin: config.bitcoin },
    fetcher,
  );
  assert.equal(bitcoinOnly.certified('bitcoin', 'regtest'), true);
  assert.equal(bitcoinOnly.certified('ethereum', '11155111'), false);
  const quicknodeOnly = new RoutingExchangeWatchProvider(
    { ...config, bitcoin: undefined },
    fetcher,
  );
  assert.equal(quicknodeOnly.certified('ethereum', '11155111'), true);
  assert.equal(quicknodeOnly.certified('bitcoin', 'regtest'), false);
  await assert.rejects(
    () =>
      provider.install({
        protocolVersion: 1,
        provider: 'quicknode',
        domainId: 'domain',
        resetEpoch: 'epoch',
        walletId: randomUUID(),
        registryRevision: 1,
        generation: randomUUID(),
        chain: 'bitcoin',
        network: 'regtest',
        address: 'fixture',
        assetScope: 'native',
      }),
    /selected chain\/network route/,
  );
});

test(
  'registry readiness uses the Bitcoin route without pausing separately certified Ethereum addresses',
  { skip: !enabled },
  async () => {
    const bitcoinCertificate: ProviderCertification = {
      ...certificate,
      provider: 'bitcoin-core',
      chain: 'bitcoin',
      network: 'regtest',
      nativeTraceCoverage: undefined,
    };
    const fetcher = (async (url, options) => {
      const request = JSON.parse(String(options!.body)) as ProviderInstallRequest &
        ProviderBackfillRequest &
        ProviderRemoveRequest;
      const result = String(url).endsWith('/install')
        ? {
            ...identity(request),
            status: 'installed',
            watchId: `watch-${request.generation}`,
            startCursor: '100',
          }
        : String(url).endsWith('/backfill')
          ? page(request)
          : { ...identity(request), watchId: request.watchId, status: 'removed' };
      return new Response(JSON.stringify(result), { status: 200 });
    }) as typeof fetch;
    const config = {
      name: 'quicknode' as const,
      url: 'https://quicknode-gateway.example',
      apiKey: 'quicknode-key',
      certifications: [certificate],
      nativeTraceMode: 'callTracer' as const,
      bitcoin: {
        url: 'http://127.0.0.1:8090',
        apiKey: 'bitcoin-key',
        certifications: [bitcoinCertificate],
      },
    };
    const service = new ActivityRegistryService(
      db!,
      auth,
      new RoutingExchangeWatchProvider(config, fetcher),
    );
    const ethereum = registration({ domainId: `${domainId}-routes` });
    await ensureCustody(ethereum);
    await service.register(ethereum);
    const bitcoin = registration(
      { domainId: `${domainId}-routes` },
      { chain: 'bitcoin', network: 'regtest', address: 'bcrt1qregistrytestaddress' },
    );
    await ensureCustody(bitcoin, false);
    await service.register(bitcoin);
    const registered = await row(bitcoin.data.walletId);
    assert.equal(registered.status, 'ready');
    assert.equal((registered.provider_ack as { provider: string }).provider, 'bitcoin-core');
    const unavailableBitcoin = new ActivityRegistryService(
      db!,
      auth,
      new RoutingExchangeWatchProvider(
        { ...config, bitcoin: { ...config.bitcoin, apiKey: undefined } },
        fetcher,
      ),
    );
    await unavailableBitcoin.recoverPending();
    assert.equal((await row(bitcoin.data.walletId)).status, 'rebuilding');
    assert.equal((await row(ethereum.data.walletId)).status, 'ready');
    await service.recover(bitcoin.data.walletId);
    assert.equal((await row(bitcoin.data.walletId)).status, 'ready');
    assert.equal((await row(ethereum.data.walletId)).status, 'ready');
  },
);

test(
  'initial watches without an issuance cursor backfill from origin instead of silently starting at the current tip',
  { skip: !enabled },
  async () => {
    const provider = new FixtureProvider();
    const service = new ActivityRegistryService(db!, auth, provider);
    const request = registration({}, { startCursor: undefined });
    await ensureCustody(request);
    await service.register(request);
    const ready = await row(request.data.walletId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.start_cursor, '100');
    assert.equal(ready.coverage_start_cursor, 'origin');
    assert.equal(provider.installs[0].fromCursor, undefined);
    assert.equal(provider.backfills[0].fromCursor, 'origin');
    assert.equal(provider.backfills[0].throughCursor, '100');
  },
);

test('Token coverage requires the selected provider, token history and Solana owned-account certification', () => {
  const tokens: ProviderCertification = {
    ...certificate,
    assetScope: 'native-and-transfer-tokens',
    tokenTransferCoverage: true,
    tokenHistoryCoverage: true,
  };
  const provider = (certifications: ProviderCertification[]) =>
    new HttpExchangeWatchProvider({
      name: 'quicknode',
      url: 'https://provider.example',
      apiKey: 'fixture-key',
      nativeTraceMode: 'callTracer',
      certifications,
    });
  assert.equal(provider([certificate]).tokenCertified('ethereum', '11155111'), false);
  assert.equal(provider([tokens]).tokenCertified('ethereum', '11155111'), true);
  assert.equal(provider([tokens]).tokenCertified('ethereum', '1'), false);
  assert.equal(
    provider([certificate, { ...tokens, provider: 'bitcoin-core' }]).tokenCertified(
      'ethereum',
      '11155111',
    ),
    false,
  );
  const solana: ProviderCertification = { ...tokens, chain: 'solana', network: 'fixture-solana' };
  assert.equal(provider([solana]).tokenCertified('solana', 'fixture-solana'), false);
  assert.equal(
    provider([{ ...solana, ownedTokenAccountCoverage: true }]).tokenCertified(
      'solana',
      'fixture-solana',
    ),
    true,
  );
  assert.throws(() =>
    providerCertificationSchema.parse({ ...tokens, tokenHistoryCoverage: undefined }),
  );
});
