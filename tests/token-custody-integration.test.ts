import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { SweepPrismaService } from '../apps/sweep/src/prisma/prisma.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { ExchangeCustomersService } from '../apps/wallet/src/customers/customers.service.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';

import { CustodyExecutionService } from '../apps/wallet/src/execution/execution.service.js';
import { WalletWorkflowService } from '../apps/wallet/src/messaging/wallet-workflow.service.js';
import {
  WithdrawalsService,
  withdrawalRequestSchema,
} from '../apps/wallet/src/withdrawals/withdrawals.service.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import { ExchangeRegistryService } from '../apps/ledger/src/exchange/registry.service.js';
import { AccountsService } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { SettlementsService } from '../apps/ledger/src/settlements/settlements.service.js';
import { SweepService } from '../apps/sweep/src/sweep/sweep.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import { MessageAuth, messageSchema, QUEUES } from '../packages/queue/src/messages.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import {
  custodySettings,
  devnet,
  isolatedDatabase,
  testMnemonic,
} from './helpers/custody-fixture.js';

import { ActivityPrismaService } from '../apps/activity-listener/src/prisma/prisma.service.js';
import { BroadcastPrismaService } from '../apps/broadcast/src/prisma/prisma.service.js';
import { BroadcastService } from '../apps/broadcast/src/broadcast/broadcast.service.js';
import { ActivityRegistryService } from '../apps/activity-listener/src/registry/registry.service.js';
import { TokenRegistryService } from '../apps/activity-listener/src/registry/token-registry.service.js';
import { ActivityExchangeService } from '../apps/activity-listener/src/exchange/exchange.service.js';
import { TokenAssetsService } from '../apps/wallet/src/custody-api/token-assets.service.js';
import { TokenSigningPolicy } from '../apps/signer/src/signing/token-signing.policy.js';
import { TokenChainFixture, ercCertificate } from './helpers/token-chain-fixture.js';
import {
  TokenCertificate,
  tokenAsset,
  CLASSIC_TOKEN_PROGRAM,
} from '../packages/shared/src/token-contracts.js';
import {
  ExchangeVerifier,
  VerifiedExchangeTransaction,
} from '../packages/chain/src/exchange-verifier.js';
import { ExchangeDiscoverySignal } from '../packages/shared/src/exchange-discovery.js';
import { ExchangeWatchProvider } from '../apps/activity-listener/src/provider/provider.contracts.js';
import { getWalletCore } from '../packages/chain/src/coin-metadata.js';
import { associatedTokenAddress } from '../packages/chain/src/token-encoding.js';
import { AccountSpec, accountNormalSides } from '../apps/ledger/src/accounts/accounts.service.js';

const enabled = [
  'TEST_DATABASE_URL',
  'TEST_LEDGER_DATABASE_URL',
  'TEST_SWEEP_DATABASE_URL',
  'TEST_ACTIVITY_DATABASE_URL',
  'TEST_BROADCAST_DATABASE_URL',
].every((k) => !!process.env[k]);
const fixtures: Awaited<ReturnType<typeof isolatedDatabase>>[] = [];
const auth = new MessageAuth('t'.repeat(64), randomUUID()),
  domainId = `tokens-${randomUUID()}`;
const config = custodySettings(domainId),
  settings = { domainId, apiKey: 'x'.repeat(64) };
const authority = generateKeyPairSync('ed25519'),
  attestor = generateKeyPairSync('ed25519');
const executionSettings = {
  enabled: true,
  withdrawalsEnabled: true,
  tokensEnabled: true,
  authorityPrivateKey: authority.privateKey,
  signerPublicKey: attestor.publicKey,
  pollIntervalMs: 1,
};
let db: WalletPrismaService,
  ledger: LedgerPrismaService,
  sweepDb: SweepPrismaService,
  activityDb: ActivityPrismaService,
  broadcastDb: BroadcastPrismaService;
let custody: CustodyService,
  customers: ExchangeCustomersService,
  exchange: ExchangeMessagingService,
  workflow: WalletWorkflowService,
  signer: SigningService,
  core: SigningCore;
let registry: ExchangeRegistryService,
  deposits: DepositsService,
  settlements: SettlementsService,
  reservations: ReservationsService,
  journal: JournalService,
  sweep: SweepService;
let execution: CustodyExecutionService,
  withdrawals: WithdrawalsService,
  broadcast: BroadcastService,
  activity: ActivityExchangeService,
  activityRegistry: ActivityRegistryService,
  tokenRegistry: TokenRegistryService,
  assets: TokenAssetsService;
let ethereumFixture: Awaited<ReturnType<typeof fixture>>,
  solanaFixture: Awaited<ReturnType<typeof fixture>>,
  solanaWithdrawalId: string;
const rpc = new TokenChainFixture(),
  verified = new Map<string, VerifiedExchangeTransaction>(),
  seen = new Set<string>();
const provider: ExchangeWatchProvider = {
  name: 'quicknode',
  certified: () => true,
  tokenCertified: () => true,
  async install(request) {
    const { fromCursor: _from, ...identity } = request;
    return {
      ...identity,
      status: 'installed',
      watchId: `watch:${identity.generation}`,
      startCursor: '100',
    };
  },
  async backfill(request) {
    return { ...request, cursor: request.throughCursor, complete: true, transactionHashes: [] };
  },
  async remove(request) {
    return { ...request, status: 'removed' };
  },
};

function event(type: string, data: unknown, extra: Record<string, unknown> = {}): ExchangeEvent {
  return exchangeEventSchema.parse({
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    domainId,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    causationId: null,
    aggregateId: randomUUID(),
    revision: 1,
    type,
    data,
    ...extra,
  });
}

async function pump() {
  for (let round = 0; round < 30; round++) {
    let progress = 0;
    for (const [label, store] of [
      ['wallet', db],
      ['ledger', ledger],
      ['sweep', sweepDb],
      ['activity', activityDb],
      ['broadcast', broadcastDb],
    ] as const) {
      for (const row of await (store as WalletPrismaService).outbox.findMany({
        orderBy: { created_at: 'asc' },
      })) {
        const key = `${label}:${row.id}`;
        if (seen.has(key)) continue;
        const parsed = messageSchema.parse(row.payload),
          id = randomUUID(),
          message = auth.open(auth.seal(parsed, id), id, parsed.type);
        let handled = true;
        if (row.queue === QUEUES.signer) {
          const result =
            message.type === 'transaction.token.sign'
              ? await signer.executeToken(message)
              : signer.execute(message);
          assert.notEqual(result.type, 'transaction.custody.rejected', JSON.stringify(result));
          if (result.type === 'wallet.derived') await workflow.handle(result, id, false);
          else await execution.handle(result);
        } else if (row.queue === QUEUES.wallet) {
          if (
            [
              'customer.registry.acknowledged.v1',
              'custody-wallet.registry.acknowledged.v1',
              'customer-wallet.registry.acknowledged.v1',
            ].includes(message.type)
          )
            await exchange.handle(message as ExchangeEvent);
          else {
            const e = await execution.handle(message);
            const w = await withdrawals.handle(message);
            if (!e && !w) handled = false;
          }
        } else if (row.queue === QUEUES.ledger) {
          const e = exchangeEventSchema.parse(message);
          if (
            [
              'customer.registry.requested.v1',
              'customer-wallet.registry.requested.v1',
              'custody-wallet.registry.requested.v1',
            ].includes(e.type)
          )
            await registry.handle(e);
          else if (e.type.startsWith('deposit.')) await deposits.handle(e);
          else if (
            e.type === 'withdrawal.reserve.requested.v1' ||
            e.type === 'reservation.release.requested.v1'
          )
            await reservations.handle(e);
          else if (
            [
              'sweep.execute.requested.v1',
              'funding.execute.requested.v1',
              'withdrawal.execute.requested.v1',
              'execution.attempt.updated.v1',
              'settlement.requested.v1',
              'settlement.reverted.v1',
            ].includes(e.type)
          )
            await settlements.handle(e).catch((error) => {
              throw new Error(`${e.type}: ${JSON.stringify('data' in e ? e.data : {})}`, {
                cause: error,
              });
            });
          else handled = false;
        } else if (row.queue === QUEUES.sweep) {
          await sweep.handle(exchangeEventSchema.parse(message));
        } else if (row.queue === QUEUES.activity) {
          if (
            message.type === 'custody-wallet.registry.requested.v1' ||
            message.type === 'customer-wallet.registry.requested.v1'
          )
            await activityRegistry.register(message);
          else if (message.type === 'asset.transfer.registry.requested.v1')
            await tokenRegistry.register(message);
          else if (
            [
              'sweep.execute.requested.v1',
              'funding.execute.requested.v1',
              'withdrawal.execute.requested.v1',
              'execution.attempt.updated.v1',
            ].includes(message.type)
          )
            await activity.observeOperation(message as ExchangeEvent);
          else handled = false;
        } else if (row.queue === QUEUES.broadcast && message.type === 'broadcast.requested') {
          rpc.register(message.snapshot);
          await broadcast.execute(message, false);
        } else handled = false;
        if (handled) {
          seen.add(key);
          progress++;
        }
      }
    }
    if (!progress) return;
  }
  throw new Error('Saga did not quiesce');
}

before(async () => {
  if (!enabled) return;
  for (const [source, app] of [
    [process.env.TEST_DATABASE_URL!, 'wallet'],
    [process.env.TEST_LEDGER_DATABASE_URL!, 'ledger'],
    [process.env.TEST_SWEEP_DATABASE_URL!, 'sweep'],
    [process.env.TEST_ACTIVITY_DATABASE_URL!, 'activity'],
    [process.env.TEST_BROADCAST_DATABASE_URL!, 'broadcast'],
  ] as const)
    fixtures.push(await isolatedDatabase(source, app));
  db = new WalletPrismaService({ databaseUrl: fixtures[0].url });
  ledger = new LedgerPrismaService({ databaseUrl: fixtures[1].url });
  sweepDb = new SweepPrismaService({ databaseUrl: fixtures[2].url });
  activityDb = new ActivityPrismaService({ databaseUrl: fixtures[3].url });
  broadcastDb = new BroadcastPrismaService({ databaseUrl: fixtures[4].url });
  custody = new CustodyService(db, config, settings, auth);
  registry = new ExchangeRegistryService(ledger);
  customers = new ExchangeCustomersService(
    db,
    settings,
    auth,
    {
      exchangeBalances: (d: string, c: string) => registry.balances(d, c),
    } as unknown as LedgerClient,
    custody,
  );
  exchange = new ExchangeMessagingService(db, auth, customers);
  workflow = new WalletWorkflowService(db, rpc, config, exchange, custody, customers, auth);
  core = await SigningCore.create(testMnemonic, config.seedId, config.ethereumChainId, undefined, {
    domainId,
    chainNetworks: {
      ethereum: { network: '11155111', chainId: '11155111' },
      bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
      solana: { network: devnet, genesisHash: devnet },
    },
  });
  signer = new SigningService(
    core,
    new CustodySigningPolicy(
      {
        enabled: true,
        withdrawalsEnabled: true,
        fundingEnabled: true,
        domainId,
        resetEpoch: auth.resetEpoch,
        authorityPublicKey: authority.publicKey,
        attestationPrivateKey: attestor.privateKey,
      },
      core,
    ),
    new TokenSigningPolicy(
      {
        enabled: true,
        domainId,
        resetEpoch: auth.resetEpoch,
        authorityPublicKey: authority.publicKey,
      },
      core,
    ),
  );
  journal = new JournalService(new AccountsService());
  deposits = new DepositsService(ledger, journal, auth);
  reservations = new ReservationsService(ledger, journal, auth);
  settlements = new SettlementsService(ledger, journal, reservations);
  sweep = new SweepService(sweepDb, auth, {
    domainId,
    enableNativeSweeps: true,
    enableTokenSweeps: true,
    retryDelayMs: 0,
  });
  execution = new CustodyExecutionService(db, custody, rpc, config, executionSettings, auth);
  withdrawals = new WithdrawalsService(db, custody, exchange, auth, config, executionSettings);
  activityRegistry = new ActivityRegistryService(activityDb, auth, provider);
  tokenRegistry = new TokenRegistryService(activityDb, rpc, auth, provider);
  activity = new ActivityExchangeService(
    activityDb,
    {
      verify: async (s: ExchangeDiscoverySignal) =>
        structuredClone(verified.get(s.transactionHash)!),
    } as ExchangeVerifier,
    auth,
    activityRegistry,
    { pollMs: 1, reconciliationMs: 1, recoveryMs: 1 },
    tokenRegistry,
  );
  assets = new TokenAssetsService(db, rpc, auth, settings, executionSettings);
  broadcast = new BroadcastService(
    broadcastDb,
    rpc,
    {
      allowBroadcast: true,
      ethereumChainId: '11155111',
      solanaGenesisHash: devnet,
      pollIntervalMs: 1,
      maxPolls: 100,
      nativeSweepsEnabled: true,
      nativeWithdrawalsEnabled: true,
      tokenExecutionEnabled: true,
      custodyMode: true,
      domainId,
      resetEpoch: auth.resetEpoch,
      executionSignerPublicKey: attestor.publicKey,
    },
    new NativeSweepPlanner(rpc),
  );
  await custody.bootstrap();
  await pump();
});
after(async () => {
  signer?.onApplicationShutdown();
  for (const store of [db, ledger, sweepDb, activityDb, broadcastDb]) await store?.$disconnect();
  for (const f of fixtures.reverse()) await f.drop();
});

async function fixture(certificate: TokenCertificate) {
  const asset = tokenAsset(certificate),
    customerId = randomUUID();
  if (certificate.standard === 'spl') rpc.solCertificate = certificate;
  await exchange.handle(
    event('user.registered.v1', { userId: customerId }, { customerId, aggregateId: customerId }),
  );
  await pump();
  const assignment = await customers.assign(customerId, certificate.chain, certificate.network);
  await customers.issueAssignment(assignment.assignmentId, domainId);
  await pump();
  const a = await db.exchangeDepositAddressAssignment.findUniqueOrThrow({
      where: { assignment_id: assignment.assignmentId },
    }),
    source = await db.wallet.findUniqueOrThrow({ where: { id: a.wallet_id! } });
  const hot = await db.wallet.findFirstOrThrow({
      where: { chain: certificate.chain, custody_role: 'hot', custody_domain_id: domainId },
    }),
    management = await db.wallet.findFirstOrThrow({
      where: { chain: certificate.chain, custody_role: 'management', custody_domain_id: domainId },
    });
  for (const wallet of [hot, management]) {
    const amount = certificate.chain === 'ethereum' ? 10n ** 18n : 100_000_000n;
    rpc.setBalance(wallet.address!, amount);
    const native = {
      chain: certificate.chain,
      network: certificate.network,
      assetId: `token:${certificate.chain}:native`,
    };
    const spec = (type: AccountSpec['type'], ownerId: string): AccountSpec => ({
      domainId,
      ...native,
      type,
      ownerId,
      ownerKind: type === 'equity' ? 'exchange' : 'wallet',
      normalSide: accountNormalSides[type],
    });
    await ledger.$transaction((tx) =>
      journal.post(tx, {
        key: `capital:${wallet.id}`,
        domainId,
        revision: 1,
        kind: 'fixture-capital',
        postings: [
          {
            account: spec(
              wallet.custody_role === 'hot' ? 'custody_hot' : 'custody_management',
              wallet.id,
            ),
            side: 'debit',
            amount,
          },
          { account: spec('equity', domainId), side: 'credit', amount },
        ],
      }),
    );
  }
  await db.assetConfiguration.updateMany({
    where: { domain_id: domainId, chain: certificate.chain, standard: 'native' },
    data: { sweep_enabled: true },
  });
  rpc.setBalance(source.address!, 0n);
  let sourceTokenAccount: string | undefined;
  if (certificate.standard === 'erc20') rpc.setTokens(source.address!, 1000n);
  else sourceTokenAccount = await rpc.receiveSpl(source.address!, 1000n, certificate.mint);
  await assets.configure({
    certificate,
    configurationRevision: 1,
    symbol: certificate.standard.toUpperCase(),
    name: 'Deterministic transfer token',
    observationEnabled: true,
    creditEnabled: true,
    sweepEnabled: true,
    withdrawalEnabled: true,
  });
  await pump();
  const coverage = await db.tokenWalletCoverage.findUniqueOrThrow({
    where: { wallet_id_asset_id: { wallet_id: source.id, asset_id: asset.assetId } },
  });
  assert.equal(coverage.ready, true);
  const txHash =
    certificate.chain === 'ethereum'
      ? '0x' + 'cd'.repeat(32)
      : (await getWalletCore()).Base58.encodeNoCheck(Buffer.alloc(64, 7));
  const external = core.derive({
    chain: certificate.chain,
    seedId: config.seedId,
    account: 20,
  }).address;
  const destination = sourceTokenAccount ?? source.address!,
    origin =
      certificate.standard === 'spl'
        ? await associatedTokenAddress(external, certificate.mint)
        : external;
  verified.set(txHash, {
    state: 'finalized',
    chain: certificate.chain,
    network: certificate.network,
    transactionHash: txHash,
    blockHash:
      certificate.chain === 'ethereum'
        ? '0x' + 'ef'.repeat(32)
        : (await getWalletCore()).Base58.encodeNoCheck(Buffer.alloc(32, 5)),
    blockHeight: '90',
    transfersComplete: true,
    transfers: [
      {
        identity: {
          kind: certificate.standard === 'erc20' ? 'evm.log' : 'solana.instruction',
          id: '0',
        },
        from: origin,
        to: destination,
        asset,
        amount: '1000',
      },
    ],
    ...(certificate.standard === 'spl'
      ? {
          tokenAccounts: [
            {
              address: origin,
              owner: external,
              mint: certificate.mint,
              programId: CLASSIC_TOKEN_PROGRAM,
              decimals: certificate.decimals,
              preAmount: '1000',
              postAmount: '0',
            },
            {
              address: destination,
              owner: source.address!,
              mint: certificate.mint,
              programId: CLASSIC_TOKEN_PROGRAM,
              decimals: certificate.decimals,
              preAmount: '0',
              postAmount: '1000',
            },
          ],
        }
      : {}),
  });
  const signal: ExchangeDiscoverySignal = {
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    discoveryId: randomUUID(),
    source: 'live',
    chain: certificate.chain,
    network: certificate.network,
    transactionHash: txHash,
    walletId: source.id,
    registryRevision: source.registry_revision,
  };
  await activity.receive(signal);
  await activity.receive(signal);
  await pump();
  assert.equal(
    await ledger.journalBatch.count({ where: { kind: 'deposit.credit' } }),
    certificate.chain === 'ethereum' ? 1 : 2,
  );
  return { certificate, asset, customerId, source, hot, management, signal };
}

async function includeSubmitted(failed = false) {
  const pending = [...rpc.entries].filter(([, e]) => e.submitted && !e.included);
  for (const [hash] of pending) {
    await rpc.include(hash, failed);
    rpc.head += 20;
  }
  for (const c of await db.custodyExecution.findMany({
    where: { retired_at: null, state: { notIn: ['planning', 'deferred'] } },
  })) {
    await execution.reconcile(c.transaction_id);
  }
  await pump();
  return pending.length;
}

async function runSweep() {
  for (let i = 0; i < 12; i++) {
    await sweepDb.sweepWork.updateMany({ data: { next_attempt_at: new Date() } });
    await sweep.scheduleEligible();
    await pump();
    const sent = await includeSubmitted();
    if (!sent) {
      const work = await sweepDb.sweepWork.findMany();
      if (work.every((w) => w.state === 'deferred' && !w.scheduling_error)) return;
    }
  }
}

test(
  'ERC-20 custody: independently ready deposit, one capped management funding, sweep, original hot withdrawal hold and duplicate settlement',
  { skip: !enabled },
  async () => {
    const f = (ethereumFixture = await fixture(ercCertificate));
    const before = await registry.balances(domainId, f.customerId);
    await sweep.scheduleEligible();
    await pump();
    assert.ok(
      await db.tokenFeeReservation.findFirst({ where: { source_wallet_id: f.source.id } }),
      JSON.stringify({
        work: await sweepDb.sweepWork.findMany({ select: { state: true, reason: true } }),
        ops: await sweepDb.sweepOperation.findMany({
          select: { state: true, terminal_at: true, asset_id: true },
        }),
        exec: await db.custodyExecution.findMany({ select: { state: true, last_error: true } }),
        registry: await db.exchangeWalletRegistry.findMany({
          where: { wallet_id: { in: [f.source.id, f.hot.id] } },
          select: {
            ready: true,
            role: true,
            start_cursor: true,
            listener_status: true,
            ledger_status: true,
            ledger_ack_revision: true,
            listener_ack_revision: true,
            registry_revision: true,
            address: true,
          },
        }),
      }),
    );
    const funding = await db.tokenFeeReservation.findFirstOrThrow({
      where: { source_wallet_id: f.source.id, kind: 'gas_funding' },
    });
    assert.equal(
      funding.state,
      'uncertain',
      JSON.stringify(
        await db.custodyExecution.findMany({ select: { state: true, last_error: true } }),
      ),
    );
    assert.equal(await db.custodyExecution.count({ where: { operation_id: funding.id } }), 1);
    assert.equal(rpc.tokens.get(f.source.address!.toLowerCase()), 1000n);
    await runSweep();
    assert.equal(rpc.tokens.get(f.source.address!.toLowerCase()), 0n);
    assert.equal(rpc.tokens.get(f.hot.address!.toLowerCase()), 1000n);
    assert.deepEqual(await registry.balances(domainId, f.customerId), before);
    assert.equal(
      await db.tokenFeeReservation.count({
        where: { source_wallet_id: f.source.id, kind: 'gas_funding' },
      }),
      1,
    );
    assert.equal(
      (await db.tokenFeeReservation.findUniqueOrThrow({ where: { id: funding.id } })).state,
      'settled',
    );
    const request = {
      asset: f.asset,
      destination: core.derive({ chain: 'ethereum', seedId: config.seedId, account: 21 }).address,
      amount: '400',
      idempotencyKey: randomUUID(),
    };
    const withdrawal = await withdrawals.request(
      f.customerId,
      withdrawalRequestSchema.parse(request),
    );
    await pump();
    await withdrawals.repairDue();
    await pump();
    assert.equal(
      (await withdrawals.request(f.customerId, withdrawalRequestSchema.parse(request))).id,
      withdrawal.id,
    );
    await includeSubmitted();
    await pump();
    assert.equal((await withdrawals.get(f.customerId, withdrawal.id)).state, 'settled');
    assert.equal(rpc.tokens.get(f.hot.address!.toLowerCase()), 600n);
    assert.equal(
      await ledger.journalBatch.count({
        where: { operation_id: withdrawal.id, kind: 'settlement' },
      }),
      1,
    );
    const row = await db.outbox.findFirstOrThrow({
      where: {
        queue: QUEUES.ledger,
        payload: { path: ['operationId'], equals: withdrawal.id },
        AND: { payload: { path: ['type'], equals: 'settlement.requested.v1' } },
      },
    });
    await settlements.handle(exchangeEventSchema.parse(row.payload));
    assert.equal(
      await ledger.journalBatch.count({
        where: { operation_id: withdrawal.id, kind: 'settlement' },
      }),
      1,
    );
    const available = await registry.balances(domainId, f.customerId);
    const failed = await withdrawals.request(
      f.customerId,
      withdrawalRequestSchema.parse({ ...request, amount: '100', idempotencyKey: randomUUID() }),
    );
    await pump();
    await withdrawals.repairDue();
    await pump();
    await includeSubmitted(true);
    assert.equal((await withdrawals.get(f.customerId, failed.id)).state, 'failed');
    assert.equal(rpc.tokens.get(f.hot.address!.toLowerCase()), 600n);
    assert.deepEqual(await registry.balances(domainId, f.customerId), available);
  },
);

test(
  'SPL custody: token-account watch, sponsored two-signature sweep and hot rent, hot-only withdrawal and recipient rent',
  { skip: !enabled },
  async () => {
    const mint = core.derive({ chain: 'solana', seedId: config.seedId, account: 22 }).address;
    const certificate: TokenCertificate = {
      standard: 'spl',
      chain: 'solana',
      network: devnet,
      mint,
      programId: CLASSIC_TOKEN_PROGRAM,
      decimals: 6,
      certificateId: 'fixture-classic-spl',
      semantics: 'exact-transfer',
      accountClosure: 'retain',
    };
    const f = (solanaFixture = await fixture(certificate));
    const nonAta = core.derive({ chain: 'solana', seedId: config.seedId, account: 24 }).address;
    rpc.accounts.set(nonAta, { owner: f.source.address!, mint, amount: 450n, lamports: 2039280 });
    const priorWatch = await activityDb.exchangeTokenWatch.findUniqueOrThrow({
      where: { wallet_id_asset_id: { wallet_id: f.source.id, asset_id: f.asset.assetId } },
    });
    await activityDb.exchangeTokenWatch.update({
      where: { id: priorWatch.id },
      data: { next_check_at: new Date() },
    });
    await tokenRegistry.recover();
    await pump();
    const nextWatch = await activityDb.exchangeTokenWatch.findUniqueOrThrow({
      where: { id: priorWatch.id },
    });
    assert.notEqual(nextWatch.generation, priorWatch.generation);
    assert.equal(nextWatch.state, 'ready');
    const txHash = (await getWalletCore()).Base58.encodeNoCheck(Buffer.alloc(64, 8));
    const second = structuredClone(verified.get(f.signal.transactionHash)!);
    second.transactionHash = txHash;
    second.transfers[0].to = nonAta;
    second.transfers[0].amount = '450';
    second.tokenAccounts![0].preAmount = '450';
    second.tokenAccounts![1].address = nonAta;
    second.tokenAccounts![1].postAmount = '450';
    verified.set(txHash, second);
    await activity.receive({ ...f.signal, transactionHash: txHash, discoveryId: randomUUID() });
    await pump();
    const before = await registry.balances(domainId, f.customerId);
    await runSweep();
    const target = await associatedTokenAddress(f.hot.address!, mint);
    assert.equal(
      rpc.accounts.get(target)?.amount,
      1450n,
      JSON.stringify({
        work: await sweepDb.sweepWork.findMany({ select: { state: true, reason: true } }),
        ops: await sweepDb.sweepOperation.findMany({
          select: { state: true, terminal_at: true, asset_id: true },
        }),
        exec: await db.custodyExecution.findMany({ select: { state: true, last_error: true } }),
        registry: await db.exchangeWalletRegistry.findMany({
          where: { wallet_id: { in: [f.source.id, f.hot.id] } },
          select: {
            ready: true,
            role: true,
            start_cursor: true,
            listener_status: true,
            ledger_status: true,
            ledger_ack_revision: true,
            listener_ack_revision: true,
            registry_revision: true,
            address: true,
          },
        }),
      }),
    );
    assert.deepEqual(await registry.balances(domainId, f.customerId), before);
    const budget = await db.tokenFeeReservation.findFirstOrThrow({
      where: { source_wallet_id: f.source.id, kind: 'spl_sponsorship' },
    });
    assert.equal(budget.state, 'settled');
    assert.equal(budget.actual_units, '2049280');
    assert.equal(rpc.accounts.get(nonAta)?.amount, 0n);
    assert.equal(
      await db.tokenFeeReservation.count({
        where: { source_wallet_id: f.source.id, kind: 'spl_sponsorship', state: 'settled' },
      }),
      2,
    );
    const rent = await ledger.ledgerAccount.findFirstOrThrow({
      where: { owner_id: f.hot.id, type: 'custody_rent' },
    });
    assert.ok(rent);
    const request = {
      asset: f.asset,
      destination: core.derive({ chain: 'solana', seedId: config.seedId, account: 23 }).address,
      amount: '400',
      idempotencyKey: randomUUID(),
    };
    const w = await withdrawals.request(f.customerId, withdrawalRequestSchema.parse(request));
    solanaWithdrawalId = w.id;
    await pump();
    await withdrawals.repairDue();
    await pump();
    await includeSubmitted();
    assert.equal((await withdrawals.get(f.customerId, w.id)).state, 'settled');
    assert.equal(rpc.accounts.get(target)?.amount, 1050n);
    assert.equal(
      rpc.accounts.get(await associatedTokenAddress(request.destination, mint))?.amount,
      400n,
    );
    assert.equal(
      await ledger.journalBatch.count({ where: { operation_id: w.id, kind: 'settlement' } }),
      1,
    );
  },
);

test(
  'Token watch disable works during RPC outage; a stale generation cannot restore coverage or reverse valid prior credit',
  { skip: !enabled },
  async () => {
    const f = ethereumFixture,
      before = await registry.balances(domainId, f.customerId);
    const prior = exchangeEventSchema.parse(
      (
        await activityDb.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['type'], equals: 'asset.transfer.watch.acknowledged.v1' },
            AND: { payload: { path: ['data', 'ready'], equals: true } },
          },
          orderBy: { created_at: 'asc' },
        })
      ).payload,
    );
    assert.equal(prior.type, 'asset.transfer.watch.acknowledged.v1');
    rpc.outage = true;
    await assets.configure({
      certificate: f.certificate,
      configurationRevision: 2,
      symbol: 'ERC20',
      name: 'Deterministic transfer token',
      observationEnabled: false,
      creditEnabled: false,
      sweepEnabled: false,
      withdrawalEnabled: false,
    });
    await pump();
    rpc.outage = false;
    assert.equal(
      (
        await activityDb.exchangeTokenWatch.findUniqueOrThrow({
          where: { wallet_id_asset_id: { wallet_id: f.source.id, asset_id: f.asset.assetId } },
        })
      ).state,
      'paused',
    );
    await execution.handle({ ...prior, revision: 999, eventId: randomUUID() });
    assert.notEqual(
      (
        await db.tokenWalletCoverage.findUniqueOrThrow({
          where: { wallet_id_asset_id: { wallet_id: f.source.id, asset_id: f.asset.assetId } },
        })
      ).configuration_revision,
      2,
    );
    await activity.receive({ ...f.signal, discoveryId: randomUUID() });
    await pump();
    assert.deepEqual(await registry.balances(domainId, f.customerId), before);
    await assert.rejects(
      () =>
        withdrawals.request(
          f.customerId,
          withdrawalRequestSchema.parse({
            asset: f.asset,
            amount: '1',
            destination: core.derive({ chain: 'ethereum', seedId: config.seedId, account: 25 })
              .address,
            idempotencyKey: randomUUID(),
          }),
        ),
      /disabled|enabled|certif|not ready/i,
    );
    await assets.configure({
      certificate: f.certificate,
      configurationRevision: 3,
      symbol: 'ERC20',
      name: 'Deterministic transfer token',
      observationEnabled: true,
      creditEnabled: true,
      sweepEnabled: true,
      withdrawalEnabled: true,
    });
    await pump();
    assert.equal(
      (
        await db.tokenWalletCoverage.findUniqueOrThrow({
          where: { wallet_id_asset_id: { wallet_id: f.source.id, asset_id: f.asset.assetId } },
        })
      ).configuration_revision,
      3,
    );
  },
);

test(
  'Canonical SPL withdrawal reorg reverses token, fee and external rent once, restores the original hold and retains source resources',
  { skip: !enabled },
  async () => {
    const withdrawal = await db.withdrawal.findUniqueOrThrow({ where: { id: solanaWithdrawalId } }),
      e = await db.custodyExecution.findUniqueOrThrow({
        where: { operation_id: solanaWithdrawalId },
      }),
      tx = await db.transaction.findUniqueOrThrow({ where: { id: e.transaction_id } });
    rpc.orphaned.add(rpc.entries.get(tx.tx_hash!)!.block);
    await execution.reconcile(e.transaction_id);
    await pump();
    await execution.reconcile(e.transaction_id);
    await pump();
    assert.equal(
      (
        await ledger.withdrawalReservation.findUniqueOrThrow({
          where: { id: withdrawal.reservation_id! },
        })
      ).state,
      'held',
    );
    assert.equal(
      await ledger.journalBatch.count({
        where: { operation_id: withdrawal.id, kind: 'settlement_reversal' },
      }),
      1,
    );
    assert.equal(
      (await db.custodyExecution.findUniqueOrThrow({ where: { id: e.id } })).reversed,
      true,
    );
    assert.ok(
      (await db.executionResourceClaim.count({ where: { execution_id: e.id, active: true } })) > 0,
    );
    assert.equal(
      (await db.custodyDomain.findUniqueOrThrow({ where: { id: domainId } })).status,
      'paused',
    );
    assert.equal(
      (await withdrawals.get(solanaFixture.customerId, withdrawal.id)).state,
      'reconciliation_required',
    );
  },
);
