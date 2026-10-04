import 'reflect-metadata';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ActivityPrismaService } from '../apps/activity-listener/src/prisma/prisma.service.js';
import { ActivityRegistryService } from '../apps/activity-listener/src/registry/registry.service.js';
import { ActivityExchangeService } from '../apps/activity-listener/src/exchange/exchange.service.js';
import {
  ExchangeVerifier,
  VerifiedExchangeTransaction,
} from '../packages/chain/src/exchange-verifier.js';
import { ExchangeDiscoverySignal } from '../packages/shared/src/exchange-discovery.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { IncidentsService } from '../apps/ledger/src/incidents/incidents.service.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { SettlementsService } from '../apps/ledger/src/settlements/settlements.service.js';
import { migrate } from '../scripts/migrate.js';

const enabled = !!process.env.TEST_ACTIVITY_DATABASE_URL && !!process.env.TEST_LEDGER_DATABASE_URL;
const activity = enabled
  ? new ActivityPrismaService({ databaseUrl: process.env.TEST_ACTIVITY_DATABASE_URL! })
  : undefined;
const ledger = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const auth = new MessageAuth('a'.repeat(64), 'phase3-discovery-tests');
const journal = new JournalService(new AccountsService());
const depositService = ledger
  ? new DepositsService(ledger, journal, { resetEpoch: auth.resetEpoch })
  : undefined;
const incidents = ledger ? new IncidentsService(ledger, journal) : undefined;
const reservations = ledger
  ? new ReservationsService(ledger, journal, { resetEpoch: auth.resetEpoch })
  : undefined;
const settlements = ledger ? new SettlementsService(ledger, journal, reservations!) : undefined;
const ledgerRegistry = ledger ? new ExchangeRegistryService(ledger) : undefined;
const registry = activity ? new ActivityRegistryService(activity, auth) : undefined;
const asset = { chain: 'ethereum' as const, network: '11155111', assetId: 'token:ethereum:native' };
const randomHash = () => '0x' + createHash('sha256').update(randomUUID()).digest('hex');
const randomAddress = () => randomHash().slice(0, 42);
const randomBase58 = (length: number) => {
  const bytes = randomBytes(length);
  let number = BigInt(`0x${bytes.toString('hex')}`),
    encoded = '';
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  return encoded;
};
before(async () => {
  if (enabled) {
    await migrate(process.env.TEST_ACTIVITY_DATABASE_URL!, 'activity');
    await migrate(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
  }
});
after(async () => {
  await activity?.$disconnect();
  await ledger?.$disconnect();
});

function event(
  type: ExchangeEvent['type'],
  domainId: string,
  data: unknown,
  extra: Record<string, unknown> = {},
) {
  return exchangeEventSchema.parse({
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
    ...extra,
  });
}

async function fixture(
  fixtureAsset: { chain: 'ethereum' | 'solana'; network: string; assetId: string } = asset,
) {
  const asset = fixtureAsset;
  const domainId = `discovery-${randomUUID()}`,
    customerId = randomUUID(),
    walletId = randomUUID(),
    hotWalletId = randomUUID(),
    managementId = randomUUID();
  const addressFactory = asset.chain === 'solana' ? () => randomBase58(32) : randomAddress;
  const address = addressFactory(),
    hot = addressFactory(),
    management = addressFactory(),
    external = addressFactory();
  for (const [id, role, account, address] of [
    [hotWalletId, 'hot', 0, hot],
    [managementId, 'management', 1, management],
  ] as const) {
    const registration = event('custody-wallet.registry.requested.v1', domainId, {
      walletId: id,
      role,
      account,
      address,
      chain: asset.chain,
      network: asset.network,
      registryRevision: 1,
    });
    await registry!.register(registration as never);
    await ledgerRegistry!.handle(registration);
  }
  const registration = event(
    'customer-wallet.registry.requested.v1',
    domainId,
    {
      walletId,
      hotWalletId,
      address,
      account: 10,
      chain: asset.chain,
      network: asset.network,
      registryRevision: 1,
    },
    { customerId },
  );
  await registry!.register(registration as never);
  await ledgerRegistry!.handle(registration);
  await activity!.exchangeWalletRegistration.update({
    where: { wallet_id: walletId },
    data: {
      status: 'ready',
      provider_watch_id: 'fixture-watch',
      provider_ack: { fixture: true },
      start_cursor: '0',
      backfill_cursor: '10',
      backfill_complete: true,
    },
  });
  const transactionHash = asset.chain === 'solana' ? randomBase58(64) : randomHash(),
    blockHash = asset.chain === 'solana' ? randomBase58(32) : randomHash();
  const signal: ExchangeDiscoverySignal = {
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    discoveryId: randomUUID(),
    chain: asset.chain,
    network: asset.network,
    transactionHash,
    walletId,
    registryRevision: 1,
    source: 'live',
  };
  let observation: VerifiedExchangeTransaction = {
    ...asset,
    transactionHash,
    state: 'finalized',
    blockHash,
    blockHeight: '10',
    transfersComplete: true,
    transfers: [
      {
        identity:
          asset.chain === 'solana'
            ? { kind: 'solana.instruction', id: `${transactionHash}:instruction:0:native` }
            : { kind: 'evm.native', id: 'native' },
        from: external,
        to: address,
        asset,
        amount: '100',
        ...(asset.chain === 'solana'
          ? { destinationOwnerProgram: '11111111111111111111111111111111' }
          : {}),
      },
    ],
    fee: { asset, amount: '2', payer: external },
  };
  let canonical: boolean | null = null,
    calls = 0;
  const verifier = {
    verify: async () => {
      calls++;
      return observation;
    },
    isCanonicalBlock: async () => canonical,
  } as unknown as ExchangeVerifier;
  const service = new ActivityExchangeService(activity!, verifier, auth, registry!, {
    pollMs: 100,
    reconciliationMs: 1000,
    recoveryMs: 1000,
  });
  const dispatched = new Set<string>();
  const deliver = async () => {
    const rows = await activity!.outbox.findMany({
      where: { queue: QUEUES.ledger, payload: { path: ['domainId'], equals: domainId } },
      orderBy: { created_at: 'asc' },
    });
    for (const row of rows)
      if (!dispatched.has(row.id)) {
        const message = exchangeEventSchema.parse(row.payload);
        if (
          message.type === 'deposit.observed.v1' ||
          message.type === 'deposit.finalized.v1' ||
          message.type === 'deposit.reverted.v1'
        )
          await depositService!.handle(message);
        else if (
          message.type === 'custody.loss.detected.v1' ||
          message.type === 'custody.loss.reverted.v1' ||
          message.type === 'custody.incident.opened.v1'
        )
          await incidents!.handle(message);
        dispatched.add(row.id);
      }
  };
  const account = (type: AccountSpec['type']): AccountSpec => ({
    domainId,
    ...asset,
    type,
    ownerKind: type === 'custody_deposit' ? 'wallet' : 'customer',
    ownerId: type === 'custody_deposit' ? walletId : customerId,
    normalSide: type === 'custody_deposit' ? 'debit' : 'credit',
  });
  const balance = (type: AccountSpec['type']) =>
    ledger!.$transaction((tx) => journal.balance(tx, account(type)));
  const fund = async (amount = '1000') =>
    depositService!.handle(
      event(
        'deposit.finalized.v1',
        domainId,
        {
          depositId: randomUUID(),
          walletId,
          asset,
          transferIdentity: { kind: 'evm.native', id: randomUUID() },
          transactionHash: randomHash(),
          amount,
          blockHash: randomHash(),
        },
        { customerId },
      ),
    );
  return {
    asset,
    domainId,
    customerId,
    walletId,
    hotWalletId,
    managementId,
    address,
    hot,
    management,
    external,
    signal,
    service,
    deliver,
    balance,
    fund,
    observation: () => observation,
    set: (value: VerifiedExchangeTransaction) => {
      observation = value;
    },
    canonical: (value: boolean | null) => {
      canonical = value;
    },
    calls: () => calls,
  };
}

test(
  'RPC transfers credit individually once across live/backfill and compensate one proven reorg',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const first = f.observation();
    f.set({
      ...first,
      transfers: [
        ...first.transfers,
        { ...first.transfers[0], identity: { kind: 'evm.trace', id: '1' }, amount: '30' },
      ],
    });
    await Promise.all([
      f.service.receive(f.signal),
      f.service.receive({ ...f.signal, discoveryId: randomUUID(), source: 'backfill' }),
    ]);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 130n);
    assert.equal(await activity!.exchangeTransfer.count({ where: { domain_id: f.domainId } }), 2);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 130n);
    f.set({ ...first, state: 'reverted', transfers: [], transfersComplete: false });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID(), source: 'reconcile' });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await ledger!.journalBatch.count({ where: { domain_id: f.domainId } }), 4);
  },
);
test(
  'missing finality/pruned history retains final credit; known prior block mismatch reverses',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.service.receive(f.signal);
    await f.deliver();
    f.set({ ...f.observation(), state: 'pending' });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    f.set({
      ...f.observation(),
      state: 'pending',
      blockHash: undefined,
      blockHeight: undefined,
      transfers: [],
      transfersComplete: false,
    });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    f.canonical(false);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
  },
);
test(
  'registry coverage pauses finance and old discovery hints recover after a newer registry revision',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await activity!.exchangeWalletRegistration.update({
      where: { wallet_id: f.walletId },
      data: { status: 'rebuilding', backfill_complete: false, registry_revision: 2 },
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    await activity!.exchangeWalletRegistration.update({
      where: { wallet_id: f.walletId },
      data: { status: 'ready', backfill_complete: true },
    });
    await f.service.receive({
      ...f.signal,
      discoveryId: randomUUID(),
      registryRevision: 2,
      source: 'backfill',
    });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
  },
);
test(
  'unknown outflow journals net custody loss and freezes liabilities; refunds never create new credit',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const tx = f.observation();
    f.set({
      ...tx,
      fee: { asset, amount: '2', payer: f.address },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.external,
          asset,
          amount: '100',
        },
        {
          identity: { kind: 'evm.trace', id: 'refund' },
          from: f.external,
          to: f.address,
          asset,
          amount: '80',
        },
      ],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 978n);
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    assert.equal(await activity!.exchangeTransfer.count({ where: { domain_id: f.domainId } }), 0);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 978n);
    f.set({ ...tx, state: 'reverted', transfers: [], transfersComplete: false });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 1000n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
  },
);
test(
  'late matching sweep evidence compensates provisional loss and failed unauthorized attempts account paid fees',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const observation = f.observation();
    f.set({
      ...observation,
      fee: { asset, amount: '2', payer: f.address },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.hot,
          asset,
          amount: '90',
        },
      ],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 908n);
    const operationId = randomUUID(),
      attemptId = randomUUID(),
      requestDigest = 'b'.repeat(64);
    await f.service.observeOperation(
      event(
        'sweep.execute.requested.v1',
        f.domainId,
        {
          sourceWalletId: f.walletId,
          destinationWalletId: f.hotWalletId,
          amount: { asset, amount: '90' },
        },
        { operationId, attemptId, requestDigest },
      ),
    );
    await f.service.observeOperation(
      event(
        'execution.attempt.updated.v1',
        f.domainId,
        { state: 'signed', transactionHash: f.signal.transactionHash },
        { operationId, attemptId, requestDigest, revision: 2 },
      ),
    );
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 1000n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    const failed = await fixture();
    await failed.fund();
    failed.set({
      ...failed.observation(),
      state: 'failed',
      transfers: [],
      fee: { asset, amount: '7', payer: failed.address },
    });
    await failed.service.receive(failed.signal);
    await failed.deliver();
    assert.equal(await failed.balance('custody_deposit'), 993n);
    assert.equal(await failed.balance('customer_frozen'), 1000n);
  },
);
test(
  'processing lease coalesces slow concurrent checks and stale epochs/changed discovery content never credit',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    let finish!: (value: VerifiedExchangeTransaction) => void, started!: (value?: unknown) => void;
    const begun = new Promise((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<VerifiedExchangeTransaction>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const verifier = {
      verify: async () => {
        calls++;
        started();
        return waiting;
      },
      isCanonicalBlock: async () => null,
    } as unknown as ExchangeVerifier;
    const service = new ActivityExchangeService(activity!, verifier, auth, registry!, {
      pollMs: 100,
      reconciliationMs: 1000,
      recoveryMs: 1000,
    });
    const initial = service.receive(f.signal);
    await begun;
    await service.receive({ ...f.signal, discoveryId: randomUUID() });
    assert.equal(calls, 1);
    finish(f.observation());
    await initial;
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    await assert.rejects(service.receive({ ...f.signal, resetEpoch: 'retired' }), /Stale/);
    await assert.rejects(service.receive({ ...f.signal, transactionHash: randomHash() }), /reused/);
  },
);
test(
  'incident revision guards ignore late reversals and reversal-first delivery creates no financial loss',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const incidentId = randomUUID();
    const data = {
      incidentId,
      walletId: f.walletId,
      asset,
      amount: '10',
      transactionHash: randomHash(),
      reason: 'Unexpected outflow',
    };
    await incidents!.handle(
      event('custody.loss.detected.v1', f.domainId, data, { customerId: f.customerId }) as never,
    );
    await incidents!.handle(
      event('custody.loss.detected.v1', f.domainId, data, {
        customerId: f.customerId,
        revision: 3,
      }) as never,
    );
    await incidents!.handle(
      event('custody.loss.reverted.v1', f.domainId, data, {
        customerId: f.customerId,
        revision: 2,
      }) as never,
    );
    assert.equal(await f.balance('custody_deposit'), 990n);
    const tombstone = { ...data, incidentId: randomUUID(), transactionHash: randomHash() };
    await incidents!.handle(
      event('custody.loss.reverted.v1', f.domainId, tombstone, {
        customerId: f.customerId,
        revision: 2,
      }) as never,
    );
    await incidents!.handle(
      event('custody.loss.detected.v1', f.domainId, tombstone, {
        customerId: f.customerId,
        revision: 1,
      }) as never,
    );
    assert.equal(await f.balance('custody_deposit'), 990n);
  },
);

test(
  'internal management funding and authorized hot sweeps never mint customer liabilities',
  { skip: !enabled },
  async () => {
    const funding = await fixture();
    const original = funding.observation();
    funding.set({
      ...original,
      fee: { asset, amount: '2', payer: funding.management },
      transfers: [
        { ...original.transfers[0], from: funding.management, to: funding.address, amount: '500' },
      ],
    });
    await funding.service.receive(funding.signal);
    await funding.deliver();
    assert.equal(await funding.balance('customer_available'), 0n);
    assert.equal(
      await activity!.exchangeTransfer.count({ where: { domain_id: funding.domainId } }),
      0,
    );
    const sweep = await fixture();
    await sweep.fund();
    const operationId = randomUUID(),
      attemptId = randomUUID(),
      requestDigest = 'c'.repeat(64);
    await sweep.service.observeOperation(
      event(
        'sweep.execute.requested.v1',
        sweep.domainId,
        {
          sourceWalletId: sweep.walletId,
          destinationWalletId: sweep.hotWalletId,
          amount: { asset, amount: '90' },
        },
        { operationId, attemptId, requestDigest },
      ),
    );
    await sweep.service.observeOperation(
      event(
        'execution.attempt.updated.v1',
        sweep.domainId,
        { state: 'submitted', transactionHash: sweep.signal.transactionHash },
        { operationId, attemptId, requestDigest, revision: 2 },
      ),
    );
    sweep.set({
      ...sweep.observation(),
      fee: { asset, amount: '2', payer: sweep.address },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: sweep.address,
          to: sweep.hot,
          asset,
          amount: '90',
        },
      ],
    });
    await sweep.service.receive(sweep.signal);
    await sweep.deliver();
    assert.equal(await sweep.balance('customer_available'), 1000n);
    assert.equal(await sweep.balance('customer_frozen'), 0n);
    assert.equal(
      await activity!.exchangeCustodyIncident.count({ where: { domain_id: sweep.domainId } }),
      0,
    );
    const ack = await ledger!.outbox.findUniqueOrThrow({
      where: { dedupe_key: `registry-ledger-${sweep.managementId}-1` },
    });
    const parsed = exchangeEventSchema.parse(ack.payload);
    assert.equal(parsed.type, 'customer-wallet.registry.acknowledged.v1');
    if (parsed.type === 'customer-wallet.registry.acknowledged.v1')
      assert.equal(parsed.data.status, 'ready');
  },
);

test(
  'changed canonical transfer value compensates prior credit and freezes instead of repricing',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    const observation = f.observation();
    f.set({
      ...observation,
      blockHash: randomHash(),
      transfers: [{ ...observation.transfers[0], amount: '50' }],
    });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    const customer = await ledger!.exchangeCustomer.findUniqueOrThrow({
      where: { customer_id: f.customerId },
    });
    assert.equal(customer.state, 'frozen');
    assert.equal(await ledger!.journalBatch.count({ where: { domain_id: f.domainId } }), 2);
  },
);

test(
  'ambiguous address ownership blocks credit instead of selecting a customer',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await activity!.exchangeWalletRegistration.create({
      data: {
        wallet_id: randomUUID(),
        domain_id: `ambiguous-${randomUUID()}`,
        reset_epoch: auth.resetEpoch,
        chain: asset.chain,
        network: asset.network,
        address: f.address,
        role: 'hot',
        account: 0,
        registry_revision: 1,
        request: {},
        status: 'ready',
      },
    });
    await assert.rejects(f.service.receive(f.signal), /ownership is ambiguous/);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    // This deliberately malformed duplicate is isolated to its transaction; remove it so later tests can run.
    await activity!.exchangeWalletRegistration.deleteMany({
      where: { address: f.address, role: 'hot' },
    });
  },
);

test(
  'a changed canonical outflow inclusion replaces loss without silently changing customer liability',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const tx = f.observation();
    f.set({
      ...tx,
      fee: { asset, amount: '2', payer: f.address },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.external,
          asset,
          amount: '100',
        },
      ],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 898n);
    f.set({
      ...f.observation(),
      blockHash: randomHash(),
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.external,
          asset,
          amount: '60',
        },
      ],
    });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 938n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 938n);
  },
);

test(
  'reversal-first custody evidence freezes customer and emits a result while preserving physical custody',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const incidentId = randomUUID();
    await incidents!.handle(
      event(
        'custody.loss.reverted.v1',
        f.domainId,
        {
          incidentId,
          walletId: f.walletId,
          asset,
          amount: '10',
          transactionHash: randomHash(),
          reason: 'Prior unexpected signing is no longer canonical; review required',
        },
        { customerId: f.customerId, revision: 2 },
      ) as never,
    );
    assert.equal(await f.balance('custody_deposit'), 1000n);
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    assert.equal(
      (await ledger!.exchangeCustomer.findUniqueOrThrow({ where: { customer_id: f.customerId } }))
        .state,
      'frozen',
    );
    assert.ok(
      await ledger!.outbox.findUnique({
        where: { dedupe_key: `custody-incident-recorded:${incidentId}:2` },
      }),
    );
  },
);

test(
  'incomplete native observations defer new credit, preserve prior credit, and recover without duplication',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.set({ ...f.observation(), transfersComplete: false });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('custody_deposit'), 0n);
    f.set({ ...f.observation(), transfersComplete: true });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    f.set({ ...f.observation(), transfersComplete: false, transfers: [] });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    assert.equal(await f.balance('custody_deposit'), 100n);
  },
);

test(
  'incompletely decoded customer spends freeze liability without estimating a custody loss',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    f.set({
      ...f.observation(),
      transfersComplete: false,
      fee: { asset, amount: '2', payer: f.address },
      transfers: [{ ...f.observation().transfers[0], from: f.address, to: f.external }],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 1000n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'unexpected_customer_outflow' },
      }),
      0,
    );
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'incomplete_customer_outflow' },
      }),
      1,
    );
  },
);

test(
  'Solana new credit requires spendable native ownership while later unavailable ownership preserves prior credit',
  { skip: !enabled },
  async () => {
    const solanaAsset = {
      chain: 'solana' as const,
      network: 'EtWTRABZaYq6iMfeYKouRu166VU2xqaWoxPkrZBG',
      assetId: 'token:solana:native',
    };
    const f = await fixture(solanaAsset);
    const spendable = f.observation();
    f.set({
      ...spendable,
      transfers: [{ ...spendable.transfers[0], destinationOwnerProgram: undefined }],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    f.set(spendable);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    f.set({
      ...spendable,
      transfers: [{ ...spendable.transfers[0], destinationOwnerProgram: undefined }],
    });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 100n);
    f.set({
      ...spendable,
      transfers: [{ ...spendable.transfers[0], destinationOwnerProgram: randomBase58(32) }],
    });
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('customer_frozen'), 100n);
    assert.equal(await f.balance('custody_deposit'), 100n);
  },
);

test(
  'custody incident delivery before customer registration remains retryable without an inbox tombstone',
  { skip: !enabled },
  async () => {
    const domainId = `incident-lag-${randomUUID()}`,
      customerId = randomUUID();
    const incident = event(
      'custody.incident.opened.v1',
      domainId,
      {
        incidentId: randomUUID(),
        severity: 'high',
        category: 'unexpected_outflow',
        status: 'open',
        reason: 'Review required',
      },
      { customerId },
    ) as Extract<ExchangeEvent, { type: 'custody.incident.opened.v1' }>;
    await assert.rejects(
      incidents!.handle(incident),
      (error) =>
        error instanceof Error &&
        error.name !== 'ActionRejectedError' &&
        /registry has not arrived/.test(error.message),
    );
    assert.equal(
      await ledger!.exchangeInbox.findUnique({ where: { event_id: incident.eventId } }),
      null,
    );
    await ledgerRegistry!.handle(
      event(
        'customer.registry.requested.v1',
        domainId,
        { externalId: randomUUID() },
        { customerId },
      ),
    );
    await incidents!.handle(incident);
    assert.equal(
      (await ledger!.exchangeCustomer.findUniqueOrThrow({ where: { customer_id: customerId } }))
        .state,
      'frozen',
    );
  },
);

test(
  'Ledger customer wallet registration can retry when hot registry delivery arrives later',
  { skip: !enabled },
  async () => {
    const domainId = `hot-registry-lag-${randomUUID()}`,
      customerId = randomUUID(),
      walletId = randomUUID(),
      hotWalletId = randomUUID();
    const request = event(
      'customer-wallet.registry.requested.v1',
      domainId,
      {
        walletId,
        hotWalletId,
        address: randomAddress(),
        account: 10,
        chain: asset.chain,
        network: asset.network,
        registryRevision: 1,
      },
      { customerId },
    );
    await assert.rejects(
      ledgerRegistry!.handle(request),
      (error) =>
        error instanceof Error &&
        error.name !== 'ActionRejectedError' &&
        /hot wallet has not arrived/.test(error.message),
    );
    assert.equal(
      await ledger!.exchangeInbox.findUnique({ where: { event_id: request.eventId } }),
      null,
    );
    await ledgerRegistry!.handle(
      event('custody-wallet.registry.requested.v1', domainId, {
        walletId: hotWalletId,
        role: 'hot',
        account: 0,
        address: randomAddress(),
        chain: asset.chain,
        network: asset.network,
        registryRevision: 1,
      }),
    );
    await ledgerRegistry!.handle(request);
    assert.equal(
      (await ledger!.exchangeWallet.findUniqueOrThrow({ where: { wallet_id: walletId } }))
        .hot_wallet_id,
      hotWalletId,
    );
  },
);

test(
  'matching sweep above its fee cap freezes the customer and settlement charges actual custody cost once',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const initial = 10000000000000000n,
      actualFee = 5000000000000001n,
      principal = 90n;
    await f.fund(initial.toString());
    const identity = {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      requestDigest: 'd'.repeat(64),
      customerId: f.customerId,
    };
    const intent = event(
      'sweep.execute.requested.v1',
      f.domainId,
      {
        sourceWalletId: f.walletId,
        destinationWalletId: f.hotWalletId,
        amount: { asset, amount: principal.toString() },
      },
      identity,
    );
    await settlements!.handle(intent);
    await f.service.observeOperation(intent);
    const attempt = event(
      'execution.attempt.updated.v1',
      f.domainId,
      {
        state: 'submitted',
        transactionHash: f.signal.transactionHash,
      },
      { ...identity, revision: 2 },
    );
    await settlements!.handle(attempt);
    await f.service.observeOperation(attempt);
    f.set({
      ...f.observation(),
      fee: { asset, amount: actualFee.toString(), payer: f.address },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.hot,
          asset,
          amount: principal.toString(),
        },
      ],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), initial);
    assert.equal(await f.balance('customer_available'), 0n);
    assert.equal(await f.balance('customer_frozen'), initial);
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'unexpected_customer_outflow' },
      }),
      0,
    );
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'sweep_fee_policy_breach' },
      }),
      1,
    );
    const settle = event(
      'settlement.requested.v1',
      f.domainId,
      {
        outcome: 'confirmed',
        transactionHash: f.signal.transactionHash,
        actualFees: [{ asset, amount: actualFee.toString() }],
      },
      { ...identity, revision: 1 },
    );
    await settlements!.handle(settle);
    assert.equal(await f.balance('custody_deposit'), initial - principal - actualFee);
    assert.equal(await f.balance('customer_frozen'), initial);
    const feeExpense: AccountSpec = {
      domainId: f.domainId,
      ...asset,
      type: 'fee_expense',
      ownerKind: 'exchange',
      ownerId: f.domainId,
      normalSide: 'debit',
    };
    const hotCustody: AccountSpec = {
      domainId: f.domainId,
      ...asset,
      type: 'custody_hot',
      ownerKind: 'wallet',
      ownerId: f.hotWalletId,
      normalSide: 'debit',
    };
    assert.equal(await ledger!.$transaction((tx) => journal.balance(tx, feeExpense)), actualFee);
    assert.equal(await ledger!.$transaction((tx) => journal.balance(tx, hotCustody)), principal);
    await f.service.receive({ ...f.signal, discoveryId: randomUUID() });
    await f.deliver();
    await settlements!.handle(settle);
    assert.equal(await f.balance('custody_deposit'), initial - principal - actualFee);
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'sweep_fee_policy_breach' },
      }),
      1,
    );
  },
);

test(
  'a persisted sweep with a different fee payer remains an unexpected customer outflow',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.fund();
    const identity = {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      requestDigest: 'e'.repeat(64),
    };
    await f.service.observeOperation(
      event(
        'sweep.execute.requested.v1',
        f.domainId,
        {
          sourceWalletId: f.walletId,
          destinationWalletId: f.hotWalletId,
          amount: { asset, amount: '90' },
        },
        identity,
      ),
    );
    await f.service.observeOperation(
      event(
        'execution.attempt.updated.v1',
        f.domainId,
        {
          state: 'submitted',
          transactionHash: f.signal.transactionHash,
        },
        { ...identity, revision: 2 },
      ),
    );
    f.set({
      ...f.observation(),
      fee: { asset, amount: '2', payer: f.external },
      transfers: [
        {
          identity: { kind: 'evm.native', id: 'native' },
          from: f.address,
          to: f.hot,
          asset,
          amount: '90',
        },
      ],
    });
    await f.service.receive(f.signal);
    await f.deliver();
    assert.equal(await f.balance('custody_deposit'), 910n);
    assert.equal(await f.balance('customer_frozen'), 1000n);
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'unexpected_customer_outflow' },
      }),
      1,
    );
    assert.equal(
      await activity!.exchangeCustodyIncident.count({
        where: { domain_id: f.domainId, category: 'sweep_fee_policy_breach' },
      }),
      0,
    );
  },
);
