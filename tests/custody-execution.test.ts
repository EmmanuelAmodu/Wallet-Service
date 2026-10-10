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
import { TransactionsService } from '../apps/wallet/src/transactions/transactions.service.js';
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
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import {
  Message,
  MessageAuth,
  messageSchema,
  QUEUES,
  canonical,
} from '../packages/queue/src/messages.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import {
  custodySettings,
  devnet,
  isolatedDatabase,
  testMnemonic,
} from './helpers/custody-fixture.js';

const enabled =
  !!process.env.TEST_DATABASE_URL &&
  !!process.env.TEST_LEDGER_DATABASE_URL &&
  !!process.env.TEST_SWEEP_DATABASE_URL;
const settings = { domainId: `execution-${randomUUID()}`, apiKey: 'c'.repeat(64) };
const config = custodySettings(settings.domainId),
  auth = new MessageAuth('q'.repeat(64), randomUUID());
const authority = generateKeyPairSync('ed25519'),
  attestor = generateKeyPairSync('ed25519');
const fixtures: Awaited<ReturnType<typeof isolatedDatabase>>[] = [];
let db: WalletPrismaService, ledger: LedgerPrismaService, sweepDb: SweepPrismaService;
let custody: CustodyService,
  customers: ExchangeCustomersService,
  exchange: ExchangeMessagingService,
  workflow: WalletWorkflowService;
let signer: SigningService,
  registry: ExchangeRegistryService,
  deposits: DepositsService,
  settlements: SettlementsService,
  sweep: SweepService;
const asset = { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' } as const;
const originalBlock = '0x' + '44'.repeat(32),
  replacementBlock = '0x' + '55'.repeat(32);

function event(type: string, data: unknown, extra: Record<string, unknown> = {}): ExchangeEvent {
  return exchangeEventSchema.parse({
    schemaVersion: 1,
    resetEpoch: auth.resetEpoch,
    domainId: settings.domainId,
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

class FakeRpc extends ChainRpcService {
  balance = 10n ** 18n;
  nonce = 7n;
  included = false;
  failed = false;
  outage = false;
  block = originalBlock;
  canonicalBlock = originalBlock;
  request?: Extract<Message, { type: 'transaction.custody.sign' }>['request'];
  signed?: Extract<Message, { type: 'transaction.custody.signed' }>['signed'];
  constructor() {
    super({
      ethereumChainId: '11155111',
      solanaGenesisHash: devnet,
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
  }

  override async call(
    _chain: Parameters<ChainRpcService['call']>[0],
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    if (this.outage) throw new RpcFailure(-1);
    const request = this.request?.transaction;
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7';
      case 'eth_getBalance':
        return '0x' + this.balance.toString(16);
      case 'eth_getTransactionCount':
        return '0x' + this.nonce.toString(16);
      case 'eth_getCode':
        return '0x';
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_getBlockByNumber':
        return {
          hash: params[0] === '0x10' ? this.canonicalBlock : this.block,
          number: params[0] === 'latest' ? '0x20' : params[0] === 'finalized' ? '0x20' : '0x10',
          baseFeePerGas: '0x3b9aca00',
        };
      case 'eth_getTransactionReceipt':
        return this.included
          ? {
              transactionHash: this.signed!.txHash,
              blockHash: this.block,
              blockNumber: '0x10',
              status: this.failed ? '0x0' : '0x1',
              gasUsed: '0x5208',
              effectiveGasPrice: '0x77359400',
            }
          : null;
      case 'eth_getTransactionByHash':
        assert.equal(request?.chain, 'ethereum');
        return {
          hash: this.signed!.txHash,
          from: this.request!.wallet.address,
          to: request.to,
          value: '0x' + BigInt(request.amount).toString(16),
          nonce: '0x' + BigInt(request.nonce).toString(16),
          input: '0x',
          blockHash: this.block,
          blockNumber: '0x10',
        };
      default:
        throw new Error(`Unexpected RPC ${method}`);
    }
  }
}

async function workflowHandle(message: Message) {
  const id = randomUUID();
  return workflow.handle(auth.open(auth.seal(message, id), id, message.type), id, false);
}

async function deriveOutstanding() {
  for (const row of await db.outbox.findMany({
    where: { queue: QUEUES.signer, payload: { path: ['type'], equals: 'wallet.derive' } },
  }))
    await workflowHandle(signer.execute(messageSchema.parse(row.payload)));
}

async function walletRegistry(walletId: string) {
  return exchangeEventSchema.parse(
    (
      await db.outbox.findFirstOrThrow({
        where: { queue: QUEUES.ledger, payload: { path: ['data', 'walletId'], equals: walletId } },
      })
    ).payload,
  );
}

async function ledgerAcknowledgements() {
  for (const row of await ledger.outbox.findMany({
    where: {
      queue: QUEUES.wallet,
      payload: { path: ['type'], string_contains: 'registry.acknowledged' },
    },
  }))
    await exchange.handle(exchangeEventSchema.parse(row.payload));
}

before(async () => {
  if (!enabled) return;
  for (const [source, app] of [
    [process.env.TEST_DATABASE_URL!, 'wallet'],
    [process.env.TEST_LEDGER_DATABASE_URL!, 'ledger'],
    [process.env.TEST_SWEEP_DATABASE_URL!, 'sweep'],
  ] as const)
    fixtures.push(await isolatedDatabase(source, app));
  db = new WalletPrismaService({ databaseUrl: fixtures[0].url });
  ledger = new LedgerPrismaService({ databaseUrl: fixtures[1].url });
  sweepDb = new SweepPrismaService({ databaseUrl: fixtures[2].url });
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
  workflow = new WalletWorkflowService(
    db,
    {} as ChainRpcService,
    config,
    exchange,
    custody,
    customers,
    auth,
  );
  const core = await SigningCore.create(
    testMnemonic,
    config.seedId,
    config.ethereumChainId,
    undefined,
    {
      domainId: settings.domainId,
      chainNetworks: {
        ethereum: { network: '11155111', chainId: '11155111' },
        bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
        solana: { network: devnet, genesisHash: devnet },
      },
    },
  );
  signer = new SigningService(
    core,
    new CustodySigningPolicy(
      {
        enabled: true,
        domainId: settings.domainId,
        resetEpoch: auth.resetEpoch,
        authorityPublicKey: authority.publicKey,
        attestationPrivateKey: attestor.privateKey,
      },
      core,
    ),
  );
  const journal = new JournalService(new AccountsService());
  deposits = new DepositsService(ledger, journal, auth);
  settlements = new SettlementsService(
    ledger,
    journal,
    new ReservationsService(ledger, journal, auth),
  );
  sweep = new SweepService(sweepDb, auth, {
    domainId: settings.domainId,
    enableNativeSweeps: true,
    retryDelayMs: 0,
  });
  await custody.bootstrap();
  await deriveOutstanding();
  for (const row of await db.outbox.findMany({ where: { queue: QUEUES.ledger } })) {
    const message = exchangeEventSchema.parse(row.payload);
    await registry.handle(message);
    await sweep.handle(message);
  }
  await ledgerAcknowledgements();
  await db.assetConfiguration.updateMany({
    where: { domain_id: settings.domainId, standard: 'native' },
    data: { sweep_enabled: true },
  });
});
after(async () => {
  signer?.onApplicationShutdown();
  await db?.$disconnect();
  await ledger?.$disconnect();
  await sweepDb?.$disconnect();
  for (const fixture of fixtures.reverse()) await fixture.drop();
});

async function fixture() {
  const customerId = randomUUID();
  await exchange.handle(
    event('user.registered.v1', { userId: customerId }, { customerId, aggregateId: customerId }),
  );
  const registration = exchangeEventSchema.parse(
    (
      await db.outbox.findFirstOrThrow({
        where: { queue: QUEUES.ledger, payload: { path: ['customerId'], equals: customerId } },
      })
    ).payload,
  );
  await registry.handle(registration);
  await ledgerAcknowledgements();
  const assignment = await customers.assign(customerId, 'ethereum', '11155111');
  await customers.issueAssignment(assignment.assignmentId, settings.domainId);
  await deriveOutstanding();
  const row = await db.exchangeDepositAddressAssignment.findUniqueOrThrow({
      where: { assignment_id: assignment.assignmentId },
    }),
    source = await db.wallet.findUniqueOrThrow({ where: { id: row.wallet_id! } });
  const registrationEvent = await walletRegistry(source.id);
  await registry.handle(registrationEvent);
  await sweep.handle(registrationEvent);
  await ledgerAcknowledgements();
  await exchange.handle(
    event(
      'customer-wallet.registry.acknowledged.v1',
      {
        walletId: source.id,
        registryRevision: 1,
        consumer: 'activity-listener',
        status: 'ready',
        coverageComplete: true,
        backfillCursor: 'fixture-cursor-1',
        startCursor: 'fixture-cursor-1',
      },
      { customerId },
    ),
  );
  const depositId = randomUUID();
  await deposits.handle(
    event(
      'deposit.finalized.v1',
      {
        depositId,
        walletId: source.id,
        asset,
        transferIdentity: { kind: 'evm.native', id: '0' },
        transactionHash: '0x' + randomUUID().replaceAll('-', '').padEnd(64, '0'),
        amount: String(10n ** 18n),
        blockHash: originalBlock,
        blockHeight: '1',
      },
      { customerId },
    ),
  );
  const credited = exchangeEventSchema.parse(
    (
      await ledger.outbox.findFirstOrThrow({
        where: { queue: QUEUES.sweep, payload: { path: ['data', 'depositId'], equals: depositId } },
      })
    ).payload,
  );
  await sweep.handle(credited);
  await sweep.scheduleEligible();
  const plan = exchangeEventSchema.parse(
    (
      await sweepDb.outbox.findFirstOrThrow({
        where: {
          queue: QUEUES.wallet,
          payload: { path: ['data', 'sourceWalletId'], equals: source.id },
        },
      })
    ).payload,
  );
  assert.equal(plan.type, 'sweep.plan.requested.v1');
  const rpc = new FakeRpc();
  const service = new CustodyExecutionService(
    db,
    custody,
    rpc,
    config,
    {
      enabled: true,
      authorityPrivateKey: authority.privateKey,
      signerPublicKey: attestor.publicKey,
      pollIntervalMs: 1000,
    },
    auth,
  );
  const execution = () =>
    db.custodyExecution.findUniqueOrThrow({ where: { attempt_id: plan.attemptId } });
  const responses = async (type: string, queue: string) =>
    messageSchema.parse(
      (
        await db.outbox.findFirstOrThrow({
          where: {
            queue,
            payload: { path: ['type'], equals: type },
            AND: {
              payload: {
                path: [type === 'broadcast.requested' ? 'transactionId' : 'attemptId'],
                equals: plan.attemptId,
              },
            },
          },
        })
      ).payload,
    );
  const prepare = async () => {
    await service.handle(plan);
    const prepared = await responses('sweep.plan.prepared.v1', QUEUES.sweep);
    assert.equal(prepared.type, 'sweep.plan.prepared.v1');
    await sweep.handle(prepared);
    const execute = exchangeEventSchema.parse(
      (
        await sweepDb.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['type'], equals: 'sweep.execute.requested.v1' },
            AND: {
              payload: {
                path: ['attemptId'],
                equals: plan.attemptId,
              },
            },
          },
        })
      ).payload,
    );
    assert.equal(execute.type, 'sweep.execute.requested.v1');
    return execute;
  };
  const authorize = async () => {
    const execute = await prepare();
    await settlements.handle(execute);
    await service.handle(execute);
    const action = await responses('transaction.custody.sign', QUEUES.signer);
    assert.equal(action.type, 'transaction.custody.sign');
    rpc.request = action.request;
    return action;
  };
  const sign = async () => {
    const action = await authorize();
    const result = signer.execute(action);
    assert.equal(result.type, 'transaction.custody.signed');
    rpc.signed = result.signed;
    await service.handle(result);
    return result;
  };
  const settle = async () => {
    rpc.included = true;
    await service.reconcile(plan.attemptId!);
    const request = await responses('settlement.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in request);
    await settlements.handle(request);
    const committed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: plan.operationId },
            AND: { payload: { path: ['type'], equals: 'settlement.committed.v1' } },
          },
        })
      ).payload,
    );
    await service.handle(committed);
    return committed;
  };
  return {
    customerId,
    source,
    plan,
    rpc,
    service,
    execution,
    responses,
    prepare,
    authorize,
    sign,
    settle,
  };
}

test(
  'canonical native sweep moves custody once while keeping customer liability and releases only after Ledger ACK',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const result = await f.sign();
    const before = await registry.balances(settings.domainId, f.customerId);
    const broadcast = await f.responses('broadcast.requested', QUEUES.broadcast);
    assert.equal(broadcast.type, 'broadcast.requested');
    assert.equal(broadcast.snapshot.signed.raw, result.signed.raw);
    assert.equal(broadcast.snapshot.execution!.attemptId, f.plan.attemptId);
    await assert.rejects(
      () => new TransactionsService(db, config).requestBroadcast(f.plan.attemptId!),
      /bound reconciliation/,
    );
    f.rpc.included = true;
    await f.service.reconcile(f.plan.attemptId!);
    assert.equal((await f.execution()).retired_at, null);
    assert.equal(
      await db.executionResourceClaim.count({
        where: { execution_id: f.plan.attemptId, active: true },
      }),
      1,
    );
    await f.settle();
    await f.service.reconcile(f.plan.attemptId!);
    assert.ok((await f.execution()).retired_at);
    assert.equal(
      await db.executionResourceClaim.count({
        where: { execution_id: f.plan.attemptId, active: true },
      }),
      0,
    );
    assert.deepEqual(await registry.balances(settings.domainId, f.customerId), before);
    assert.equal(
      await ledger.journalBatch.count({
        where: { operation_id: f.plan.operationId, kind: 'settlement' },
      }),
      1,
    );
    const latest = await db.outbox.findMany({
      where: { queue: QUEUES.sweep, payload: { path: ['attemptId'], equals: f.plan.attemptId } },
      orderBy: { created_at: 'asc' },
    });
    for (const delivery of latest) {
      const message = exchangeEventSchema.parse(delivery.payload);
      if (message.type === 'execution.attempt.updated.v1') await sweep.handle(message);
    }
    const committed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.sweep,
            payload: { path: ['operationId'], equals: f.plan.operationId },
            AND: { payload: { path: ['type'], equals: 'settlement.committed.v1' } },
          },
        })
      ).payload,
    );
    await sweep.handle(committed);
    assert.equal(
      (await sweepDb.sweepOperation.findUniqueOrThrow({ where: { id: f.plan.operationId } })).state,
      'confirmed',
    );
  },
);
test(
  'concurrent plans and executes retain one source fence and one independent authorization',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 5 }, () => f.service.handle(f.plan)));
    assert.equal(await db.custodyExecution.count({ where: { source_wallet_id: f.source.id } }), 1);
    const execute = await f.prepare();
    await Promise.all(Array.from({ length: 5 }, () => f.service.handle(execute)));
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `custody-sign:${f.plan.attemptId}` } }),
      1,
    );
    const another = {
      ...f.plan,
      eventId: randomUUID(),
      operationId: randomUUID(),
      attemptId: randomUUID(),
    };
    another.requestDigest = executionDigest({
      domainId: another.domainId,
      resetEpoch: another.resetEpoch,
      customerId: another.customerId,
      operationId: another.operationId,
      attemptId: another.attemptId,
      policyVersion: another.policyVersion,
      data: another.data,
    });
    await f.service.handle(another);
    assert.equal(await db.custodyExecution.count({ where: { source_wallet_id: f.source.id } }), 1);
    await assert.rejects(
      () =>
        db.custodyExecution.update({
          where: { attempt_id: f.plan.attemptId },
          data: { retired_at: new Date() },
        }),
      /cannot retire/,
    );
    await assert.rejects(
      () =>
        db.executionResourceClaim.updateMany({
          where: { execution_id: f.plan.attemptId },
          data: { active: false, released_at: new Date() },
        }),
      /authoritative source/,
    );
  },
);
test(
  'pre-sign nonce changes retire only the unsigned attempt with exact preparation proof',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const execute = await f.prepare();
    f.rpc.nonce++;
    await f.service.handle(execute);
    const state = await f.execution();
    assert.equal(state.state, 'deferred');
    assert.ok(state.retired_at);
    assert.equal(state.authorization, null);
    assert.equal(
      await db.executionResourceClaim.count({ where: { execution_id: state.id, active: true } }),
      0,
    );
    const deferred = await f.responses('sweep.plan.deferred.v1', QUEUES.sweep);
    assert.equal(deferred.type, 'sweep.plan.deferred.v1');
    assert.equal(deferred.data.terminalSafe, true);
    assert.equal(deferred.data.preparationDigest, state.preparation_digest);
    await sweep.handle(deferred);
    assert.ok(
      (await sweepDb.sweepOperation.findUniqueOrThrow({ where: { id: f.plan.operationId } }))
        .terminal_at,
    );
  },
);
test(
  'unattested legacy and substituted custody signer results cannot mutate authorized executions',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const action = await f.authorize();
    const result = signer.execute(action);
    assert.equal(result.type, 'transaction.custody.signed');
    await assert.rejects(
      () =>
        workflowHandle({
          type: 'transaction.signed',
          transactionId: f.plan.attemptId!,
          signed: result.signed,
        }),
      /independently authorized/,
    );
    await assert.rejects(
      () =>
        f.service.handle({
          ...result,
          signed: { ...result.signed, raw: result.signed.raw + '00' },
        }),
      /attestation/,
    );
    await assert.rejects(
      () => f.service.handle({ ...result, attemptId: randomUUID() }),
      /attestation/,
    );
    assert.equal((await f.execution()).state, 'signing');
    assert.equal(
      (await db.transaction.findUniqueOrThrow({ where: { id: f.plan.attemptId } })).signed,
      null,
    );
    await f.service.handle(result);
    await f.service.handle(result);
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `custody-broadcast:${f.plan.attemptId}` } }),
      1,
    );
    await assert.rejects(
      () =>
        db.transaction.update({
          where: { id: f.plan.attemptId },
          data: { signed: { raw: 'tampered', encoding: 'hex', txHash: 'x' } },
        }),
      /immutable/,
    );
    await assert.rejects(
      () =>
        db.custodyExecution.update({
          where: { attempt_id: f.plan.attemptId },
          data: { maximum_fee_units: '1' },
        }),
      /immutable/,
    );
  },
);
test(
  'a rejection after authorization retains unknown-signature resources and accepts the delayed valid result',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const action = await f.authorize();
    const result = signer.execute(action);
    assert.equal(result.type, 'transaction.custody.signed');
    const rejected = signer.execute({
      ...action,
      authorization: { ...action.authorization, signature: 'A'.repeat(86) },
    });
    assert.equal(rejected.type, 'transaction.custody.rejected');
    await f.service.handle(rejected);
    assert.equal((await f.execution()).state, 'attention');
    assert.equal((await f.execution()).retired_at, null);
    assert.equal(
      await db.executionResourceClaim.count({
        where: { execution_id: f.plan.attemptId, active: true },
      }),
      1,
    );
    await f.service.handle(result);
    assert.equal((await f.execution()).state, 'queued');
  },
);
test(
  'canonical failed execution records only its actual fee and does not consume customer liabilities',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.sign();
    const before = await registry.balances(settings.domainId, f.customerId);
    f.rpc.failed = true;
    await f.settle();
    assert.equal((await f.execution()).state, 'failed');
    assert.ok((await f.execution()).retired_at);
    assert.deepEqual(await registry.balances(settings.domainId, f.customerId), before);
    const entries = await ledger.ledgerEntry.findMany({
      where: { batch: { operation_id: f.plan.operationId } },
    });
    assert(entries.every((row) => BigInt(row.amount.toString()) === 42_000_000_000_000n));
  },
);
test(
  'closed pre-creation deferrals cannot resurrect on queue replay after policy recovery',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await db.assetConfiguration.updateMany({
      where: { domain_id: settings.domainId, chain: 'ethereum' },
      data: { sweep_enabled: false },
    });
    await f.service.handle(f.plan);
    const deferred = await f.responses('sweep.plan.deferred.v1', QUEUES.sweep);
    assert.equal(
      await db.custodyExecution.count({ where: { operation_id: f.plan.operationId } }),
      0,
    );
    assert.ok('schemaVersion' in deferred);
    await sweep.handle(deferred);
    await db.assetConfiguration.updateMany({
      where: { domain_id: settings.domainId, chain: 'ethereum' },
      data: { sweep_enabled: true },
    });
    await Promise.all([f.service.handle(f.plan), f.service.handle(f.plan)]);
    assert.equal(
      await db.custodyExecution.count({ where: { operation_id: f.plan.operationId } }),
      0,
    );
    const altered = { ...f.plan, operationId: randomUUID() };
    altered.requestDigest = executionDigest({
      domainId: altered.domainId,
      resetEpoch: altered.resetEpoch,
      customerId: altered.customerId,
      operationId: altered.operationId,
      attemptId: altered.attemptId,
      policyVersion: altered.policyVersion,
      data: altered.data,
    });
    await assert.rejects(() => f.service.handle(altered), /identity changed/);
  },
);
test(
  'paused signed attempts persist attestations and resume the same bytes after explicit policy recovery',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const action = await f.authorize();
    const result = signer.execute(action);
    assert.equal(result.type, 'transaction.custody.signed');
    f.rpc.request = action.request;
    f.rpc.signed = result.signed;
    await db.exchangeCustomer.update({
      where: { customer_id: f.customerId },
      data: { state: 'frozen' },
    });
    await f.service.handle(result);
    const current = await f.execution();
    assert.equal(current.state, 'attention');
    assert.equal(canonical(current.signer_result), canonical(result));
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `custody-broadcast:${f.plan.attemptId}` } }),
      0,
    );
    await f.service.reconcile(f.plan.attemptId!);
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `custody-broadcast:${f.plan.attemptId}` } }),
      0,
    );
    await db.exchangeCustomer.update({
      where: { customer_id: f.customerId },
      data: { state: 'active' },
    });
    await f.service.reconcile(f.plan.attemptId!);
    assert.equal((await f.execution()).state, 'queued');
    const snapshot = await f.responses('broadcast.requested', QUEUES.broadcast);
    assert.equal(snapshot.type, 'broadcast.requested');
    assert.equal(snapshot.snapshot.signed.raw, result.signed.raw);
    await f.service.reconcile(f.plan.attemptId!);
    assert.equal(
      await db.outbox.count({ where: { dedupe_key: `custody-broadcast:${f.plan.attemptId}` } }),
      1,
    );
    await assert.rejects(
      () =>
        db.custodyExecution.update({
          where: { attempt_id: f.plan.attemptId },
          data: { signer_result: { tampered: true } },
        }),
      /immutable/,
    );
  },
);
test(
  'stale canonical observation cannot resurrect inclusion after a concurrent reorg',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.sign();
    await f.settle();
    const original = NativeSweepPlanner.prototype.observe;
    let release!: () => void, started!: () => void;
    const begin = new Promise<void>((resolve) => {
        started = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    let hold = true;
    NativeSweepPlanner.prototype.observe = async function (input) {
      if (hold) {
        hold = false;
        const old = await original.call(this, input);
        started();
        await wait;
        return old;
      }
      return original.call(this, input);
    };
    try {
      const stale = f.service.reconcile(f.plan.attemptId!);
      await begin;
      f.rpc.canonicalBlock = replacementBlock;
      f.rpc.included = false;
      await f.service.reconcile(f.plan.attemptId!);
      const reverted = await f.execution();
      assert.equal(reverted.reversed, true);
      release();
      await stale;
      const result = await f.execution();
      assert.equal(result.reversed, true);
      assert.equal(result.revision, reverted.revision);
      assert.equal(result.retired_at, null);
    } finally {
      release();
      NativeSweepPlanner.prototype.observe = original;
    }
    // Recovery is an explicit test fixture operator action, never automatic in the product.
    await db.custodyDomain.update({ where: { id: settings.domainId }, data: { status: 'active' } });
  },
);
test(
  'canonical reorg preserves evidence through outages, compensates once, and discovers re-inclusion before releasing',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await f.sign();
    await f.settle();
    const before = await f.execution();
    f.rpc.outage = true;
    await f.service.reconcile(f.plan.attemptId!);
    assert.deepEqual((await f.execution()).inclusion, before.inclusion);
    f.rpc.outage = false;
    f.rpc.canonicalBlock = replacementBlock;
    f.rpc.included = false;
    await f.service.reconcile(f.plan.attemptId!);
    let current = await f.execution();
    assert.equal(current.reversed, true);
    assert.equal(current.retired_at, null);
    assert.equal(
      (await db.custodyDomain.findUniqueOrThrow({ where: { id: settings.domainId } })).status,
      'paused',
    );
    const reversal = exchangeEventSchema.parse(
      (
        await db.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.ledger,
            payload: { path: ['type'], equals: 'settlement.reverted.v1' },
            AND: { payload: { path: ['operationId'], equals: f.plan.operationId } },
          },
        })
      ).payload,
    );
    await settlements.handle(reversal);
    const reversed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['type'], equals: 'settlement.reversed.v1' },
            AND: { payload: { path: ['operationId'], equals: f.plan.operationId } },
          },
        })
      ).payload,
    );
    await f.service.handle(reversed);
    f.rpc.block = replacementBlock;
    f.rpc.included = true;
    await f.service.reconcile(f.plan.attemptId!);
    current = await f.execution();
    assert.equal(current.reversed, false);
    assert.equal(current.settlement_revision, 3);
    assert.equal(current.retired_at, null);
    assert.notEqual(canonical(current.inclusion), canonical(before.inclusion));
    assert.equal(
      current.inclusion && (current.inclusion as { blockHash: string }).blockHash,
      replacementBlock,
    );
    const replacement = exchangeEventSchema.parse(
      (
        await db.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.ledger,
            payload: { path: ['type'], equals: 'settlement.requested.v1' },
            AND: [
              { payload: { path: ['operationId'], equals: f.plan.operationId } },
              { payload: { path: ['revision'], equals: 3 } },
            ],
          },
        })
      ).payload,
    );
    await settlements.handle(replacement);
    const committed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['type'], equals: 'settlement.committed.v1' },
            AND: [
              { payload: { path: ['operationId'], equals: f.plan.operationId } },
              { payload: { path: ['revision'], equals: 3 } },
            ],
          },
        })
      ).payload,
    );
    await f.service.handle(committed);
    assert.ok((await f.execution()).retired_at);
    assert.equal(
      await ledger.journalBatch.count({ where: { operation_id: f.plan.operationId } }),
      3,
    );
    await f.service.handle(reversed);
    assert.equal((await f.execution()).reversed, false);
  },
);
