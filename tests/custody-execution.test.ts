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
import {
  TokenFeesService,
  TokenFeeRequest,
} from '../apps/wallet/src/execution/token-fees.service.js';
import { CustodyExecutionService } from '../apps/wallet/src/execution/execution.service.js';
import { WalletWorkflowService } from '../apps/wallet/src/messaging/wallet-workflow.service.js';
import {
  WithdrawalsService,
  withdrawalRequestSchema,
} from '../apps/wallet/src/withdrawals/withdrawals.service.js';
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
        withdrawalsEnabled: true,
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
    data: { sweep_enabled: true, withdrawal_enabled: true },
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
      'settled',
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

let hotNonce = 20n;

async function withdrawalFixture() {
  await db.custodyDomain.update({ where: { id: settings.domainId }, data: { status: 'active' } });
  const f = await fixture();
  await f.sign();
  await f.settle();
  const rpc = new FakeRpc();
  rpc.nonce = hotNonce++;
  const executionSettings = {
    enabled: true,
    withdrawalsEnabled: true,
    authorityPrivateKey: authority.privateKey,
    signerPublicKey: attestor.publicKey,
    pollIntervalMs: 1000,
  };
  const withdrawals = new WithdrawalsService(
    db,
    custody,
    exchange,
    auth,
    config,
    executionSettings,
  );
  const service = new CustodyExecutionService(db, custody, rpc, config, executionSettings, auth);
  const request = {
    asset,
    destination: '0x' + 'aa'.repeat(20),
    amount: '10000000000000000',
    idempotencyKey: randomUUID(),
  };
  const response = async (id: string, type: string, queue: string = QUEUES.wallet) =>
    messageSchema.parse(
      (
        await db.outbox.findFirstOrThrow({
          where: {
            queue,
            payload: { path: ['operationId'], equals: id },
            AND: { payload: { path: ['type'], equals: type } },
          },
          orderBy: { created_at: 'desc' },
        })
      ).payload,
    );
  const reserve = async (input = request) => {
    const w = await withdrawals.request(f.customerId, input);
    const event = await response(w.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in event);
    await new ReservationsService(ledger, new JournalService(new AccountsService()), auth).handle(
      event,
    );
    const result = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: w.id },
            AND: { payload: { path: ['type'], string_contains: 'withdrawal.reserve' } },
          },
          orderBy: { created_at: 'desc' },
        })
      ).payload,
    );
    await withdrawals.handle(result);
    await exchange.handle(result);
    return await withdrawals.get(f.customerId, w.id);
  };
  const prepare = async (id: string) => {
    await withdrawals.repairDue();
    await service.handle(await response(id, 'withdrawal.plan.requested.v1'));
    const result = await response(id, 'withdrawal.plan.prepared.v1');
    await withdrawals.handle(result);
    return await response(id, 'withdrawal.execute.requested.v1');
  };
  const authorize = async (id: string) => {
    await service.handle(await prepare(id));
    const event = await response(id, 'withdrawal.execute.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in event);
    await settlements.handle(event);
    const action = await response(id, 'transaction.custody.sign', QUEUES.signer);
    assert.equal(action.type, 'transaction.custody.sign');
    rpc.request = action.request;
    return action;
  };
  const sign = async (id: string) => {
    const result = signer.execute(await authorize(id));
    assert.equal(result.type, 'transaction.custody.signed');
    rpc.signed = result.signed;
    await service.handle(result);
    return result;
  };
  const settle = async (id: string) => {
    const w = await db.withdrawal.findUniqueOrThrow({ where: { id } });
    rpc.included = true;
    await service.reconcile(w.attempt_id!);
    const event = await response(id, 'settlement.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in event);
    await settlements.handle(event);
    const committed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: id },
            AND: { payload: { path: ['type'], equals: 'settlement.committed.v1' } },
          },
          orderBy: { created_at: 'desc' },
        })
      ).payload,
    );
    await service.handle(committed);
    await withdrawals.handle(committed);
    await withdrawals.handle(await response(id, 'execution.attempt.updated.v1'));
  };
  const release = async (id: string) => {
    const event = await response(id, 'reservation.release.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in event);
    await new ReservationsService(ledger, new JournalService(new AccountsService()), auth).handle(
      event,
    );
    const released = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: id },
            AND: { payload: { path: ['type'], equals: 'reservation.released.v1' } },
          },
          orderBy: { created_at: 'desc' },
        })
      ).payload,
    );
    await withdrawals.handle(released);
  };
  return {
    ...f,
    rpc,
    service,
    withdrawals,
    request,
    response,
    reserve,
    prepare,
    authorize,
    sign,
    settle,
    release,
  };
}

test(
  'native withdrawal reserves once, pays exact principal from hot0 and settles one customer obligation',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    assert.equal(w.state, 'queued');
    const duplicate = await f.withdrawals.request(f.customerId, f.request);
    assert.equal(duplicate.id, w.id);
    await assert.rejects(
      () => f.withdrawals.request(f.customerId, { ...f.request, amount: '20000000000000000' }),
      /Idempotency/,
    );
    await assert.rejects(() => f.withdrawals.get(randomUUID(), w.id), /not found/);
    await assert.rejects(
      () =>
        f.withdrawals.request(f.customerId, {
          ...f.request,
          idempotencyKey: randomUUID(),
          destination: f.source.address!,
        }),
      /Exchange-owned/,
    );
    const result = await f.sign(w.id);
    assert.equal(f.rpc.request!.wallet.account, 0);
    assert.equal(f.rpc.request!.transaction.chain, 'ethereum');
    if (f.rpc.request!.transaction.chain === 'ethereum')
      assert.equal(f.rpc.request!.transaction.amount, f.request.amount);
    assert.equal(result.type, 'transaction.custody.signed');
    await assert.rejects(() => f.withdrawals.cancel(f.customerId, w.id), /Authorized/);
    await f.settle(w.id);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'settled');
    assert.equal(await ledger.withdrawalReservation.count({ where: { operation_id: w.id } }), 1);
    assert.equal(
      await ledger.journalBatch.count({ where: { operation_id: w.id, kind: 'settlement' } }),
      1,
    );
    assert.ok(
      (await db.custodyExecution.findUniqueOrThrow({ where: { operation_id: w.id } })).retired_at,
    );
    const balances = await registry.balances(settings.domainId, f.customerId);
    assert.equal(balances.balances[0].available, String(10n ** 18n - BigInt(f.request.amount)));
    await f.service.reconcile(
      (await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).attempt_id!,
    );
    assert.equal(
      await ledger.journalBatch.count({ where: { operation_id: w.id, kind: 'settlement' } }),
      1,
    );
  },
);

test(
  'withdrawal backlog retains a customer hold for low hot liquidity and cancellation closes unsigned execution',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    f.rpc.balance = 0n;
    await f.withdrawals.repairDue();
    await f.service.handle(await f.response(w.id, 'withdrawal.plan.requested.v1'));
    await f.withdrawals.handle(await f.response(w.id, 'execution.attempt.updated.v1'));
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'waiting_liquidity');
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      0,
    );
    assert.equal(
      (await ledger.withdrawalReservation.findUniqueOrThrow({ where: { operation_id: w.id } }))
        .state,
      'held',
    );
    await f.withdrawals.cancel(f.customerId, w.id);
    await f.release(w.id);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'cancelled');
    await f.service.handle(await f.response(w.id, 'withdrawal.plan.requested.v1'));
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      0,
    );
  },
);

test(
  'cancellation before reservation result delivery recovers the original hold and releases it once',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.withdrawals.request(f.customerId, f.request);
    await f.withdrawals.cancel(f.customerId, w.id);
    const event = await f.response(w.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in event);
    await new ReservationsService(ledger, new JournalService(new AccountsService()), auth).handle(
      event,
    );
    const result = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: { queue: QUEUES.wallet, payload: { path: ['operationId'], equals: w.id } },
        })
      ).payload,
    );
    await f.withdrawals.handle(result);
    await f.release(w.id);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'cancelled');
    assert.equal(
      (await ledger.withdrawalReservation.findUniqueOrThrow({ where: { operation_id: w.id } }))
        .state,
      'released',
    );
  },
);

test(
  'withdrawal failed on chain releases principal and records actual exchange fee without duplicate payout',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    await f.sign(w.id);
    f.rpc.failed = true;
    await f.settle(w.id);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'failed');
    const balance = await registry.balances(settings.domainId, f.customerId);
    assert.equal(balance.balances[0].available, String(10n ** 18n));
    const batches = await ledger.journalBatch.findMany({
      where: { operation_id: w.id, kind: 'settlement' },
      include: { entries: true },
    });
    assert.equal(batches.length, 1);
    assert.ok(batches[0].entries.length > 0);
  },
);

test(
  'withdrawal post-settlement reorg restores its original obligation and never queues replacement bytes',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    await f.sign(w.id);
    await f.settle(w.id);
    const execution = await db.custodyExecution.findUniqueOrThrow({
      where: { operation_id: w.id },
    });
    f.rpc.canonicalBlock = replacementBlock;
    await f.service.reconcile(execution.transaction_id);
    await f.withdrawals.handle(await f.response(w.id, 'execution.attempt.updated.v1'));
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'reconciliation_required');
    const reversal = await f.response(w.id, 'settlement.reverted.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in reversal);
    await settlements.handle(reversal);
    const result = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: w.id },
            AND: { payload: { path: ['type'], equals: 'settlement.reversed.v1' } },
          },
        })
      ).payload,
    );
    await f.service.handle(result);
    await f.withdrawals.handle(result);
    assert.equal(
      (await ledger.withdrawalReservation.findUniqueOrThrow({ where: { operation_id: w.id } }))
        .state,
      'held',
    );
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      1,
    );
    assert.equal(
      (await db.custodyDomain.findUniqueOrThrow({ where: { id: settings.domainId } })).status,
      'paused',
    );
    // Resolve the fixture's canonical inclusion so subsequent tests have a free hot fence.
    f.rpc.block = replacementBlock;
    await f.service.reconcile(execution.transaction_id);
    await f.settle(w.id);
  },
);

test('withdrawal input forbids customer-selected sources, fees, nonces and UTXOs', () => {
  for (const field of ['sourceWalletId', 'path', 'nonce', 'utxos', 'customerFee'])
    assert.equal(
      withdrawalRequestSchema.safeParse({
        asset,
        destination: '0x' + 'aa'.repeat(20),
        amount: '1',
        idempotencyKey: 'x',
        [field]: 'unexpected',
      }).success,
      false,
    );
});

test(
  'concurrent customer withdrawals cannot over-reserve and the hot scheduler admits only one intent',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const body = { ...f.request, amount: '600000000000000000' };
    const [a, duplicate, b] = await Promise.all([
      f.withdrawals.request(f.customerId, body),
      f.withdrawals.request(f.customerId, body),
      f.withdrawals.request(f.customerId, { ...body, idempotencyKey: randomUUID() }),
    ]);
    assert.equal(a.id, duplicate.id);
    const reservations = new ReservationsService(
      ledger,
      new JournalService(new AccountsService()),
      auth,
    );
    for (const w of [a, b]) {
      const intent = await f.response(w.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
      assert.ok('schemaVersion' in intent);
      await reservations.handle(intent);
      const result = exchangeEventSchema.parse(
        (
          await ledger.outbox.findFirstOrThrow({
            where: { queue: QUEUES.wallet, payload: { path: ['operationId'], equals: w.id } },
          })
        ).payload,
      );
      await f.withdrawals.handle(result);
    }
    assert.deepEqual(
      [
        (await f.withdrawals.get(f.customerId, a.id)).state,
        (await f.withdrawals.get(f.customerId, b.id)).state,
      ],
      ['queued', 'rejected'],
    );
    assert.equal(
      (await registry.balances(settings.domainId, f.customerId)).balances[0].reserved,
      body.amount,
    );
    // A separate customer's payable work queues behind the first hot intent.
    const other = await fixture();
    const queued = await f.withdrawals.request(other.customerId, {
      ...f.request,
      idempotencyKey: randomUUID(),
    });
    const intent = await f.response(queued.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in intent);
    await reservations.handle(intent);
    const result = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: { queue: QUEUES.wallet, payload: { path: ['operationId'], equals: queued.id } },
        })
      ).payload,
    );
    await f.withdrawals.handle(result);
    await Promise.all([f.withdrawals.repairDue(), f.withdrawals.repairDue()]);
    assert.equal(
      await db.withdrawal.count({
        where: { hot_wallet_id: f.source.hot_wallet_id!, state: 'planning' },
      }),
      1,
    );
    for (const w of [a, queued]) {
      await f.withdrawals.cancel(w.id === a.id ? f.customerId : other.customerId, w.id);
      await f.release(w.id);
    }
  },
);

test(
  'lost reservation result repair republishes the original immutable quote without creating another hold',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.withdrawals.request(f.customerId, f.request);
    const first = await f.response(w.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in first);
    const reservations = new ReservationsService(
      ledger,
      new JournalService(new AccountsService()),
      auth,
    );
    await reservations.handle(first);
    await db.withdrawal.update({ where: { id: w.id }, data: { next_check_at: new Date(0) } });
    await f.withdrawals.repairDue();
    const replay = await f.response(w.id, 'withdrawal.reserve.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in replay);
    assert.notEqual(replay.eventId, first.eventId);
    assert.deepEqual(replay.data, first.data);
    await reservations.handle(replay);
    assert.equal(await ledger.withdrawalReservation.count({ where: { operation_id: w.id } }), 1);
    assert.equal(
      await ledger.journalBatch.count({
        where: { operation_id: w.id, kind: 'withdrawal.reserve' },
      }),
      1,
    );
    const deliveries = await ledger.outbox.findMany({
      where: { queue: QUEUES.wallet, payload: { path: ['operationId'], equals: w.id } },
    });
    assert.equal(deliveries.length, 2);
    await f.withdrawals.handle(messageSchema.parse(deliveries.at(-1)!.payload));
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'queued');
    await f.withdrawals.cancel(f.customerId, w.id);
    await f.release(w.id);
  },
);

test(
  'customer freeze between preparation and authorization prevents signing and safely closes the hold',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    const execute = await f.prepare(w.id);
    await db.exchangeCustomer.update({
      where: { customer_id: f.customerId },
      data: { state: 'frozen' },
    });
    await f.service.handle(execute);
    await f.withdrawals.handle(await f.response(w.id, 'withdrawal.plan.deferred.v1'));
    await f.release(w.id);
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      0,
    );
    assert.equal(await ledger.exchangeOperation.count({ where: { id: w.id } }), 0);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'cancelled');
  },
);

test(
  'withdrawal cancellation racing authorization either cancels unsigned work or retains the authorized hold',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    const execute = await f.prepare(w.id);
    const outcomes = await Promise.allSettled([
      f.service.handle(execute),
      f.withdrawals.cancel(f.customerId, w.id),
    ]);
    const execution = await db.custodyExecution.findUniqueOrThrow({
      where: { operation_id: w.id },
    });
    if (execution.authorization) {
      assert.equal(outcomes[1].status, 'rejected');
      assert.equal(execution.retired_at, null);
      const action = await f.response(w.id, 'transaction.custody.sign', QUEUES.signer);
      assert.equal(action.type, 'transaction.custody.sign');
      f.rpc.request = action.request;
      const result = signer.execute(action);
      assert.equal(result.type, 'transaction.custody.signed');
      f.rpc.signed = result.signed;
      const intent = await f.response(w.id, 'withdrawal.execute.requested.v1', QUEUES.ledger);
      assert.ok('schemaVersion' in intent);
      await settlements.handle(intent);
      await f.service.handle(result);
      await f.settle(w.id);
    } else {
      assert.equal(outcomes[1].status, 'fulfilled');
      assert.ok(execution.retired_at);
      await f.release(w.id);
      assert.equal(
        await db.outbox.count({
          where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
        }),
        0,
      );
    }
  },
);

test(
  'withdrawal recovery republishes lost preparation and terminal proof without changing the attempt or bytes',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const w = await f.reserve();
    await f.withdrawals.repairDue();
    await f.service.handle(await f.response(w.id, 'withdrawal.plan.requested.v1'));
    await db.withdrawal.update({ where: { id: w.id }, data: { next_check_at: new Date(0) } });
    await f.withdrawals.repairDue();
    await f.withdrawals.handle(await f.response(w.id, 'withdrawal.plan.prepared.v1'));
    await f.service.handle(await f.response(w.id, 'withdrawal.execute.requested.v1'));
    const intent = await f.response(w.id, 'withdrawal.execute.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in intent);
    await settlements.handle(intent);
    const action = await f.response(w.id, 'transaction.custody.sign', QUEUES.signer);
    assert.equal(action.type, 'transaction.custody.sign');
    f.rpc.request = action.request;
    const signed = signer.execute(action);
    assert.equal(signed.type, 'transaction.custody.signed');
    f.rpc.signed = signed.signed;
    await f.service.handle(signed);
    const execution = await db.custodyExecution.findUniqueOrThrow({
      where: { operation_id: w.id },
    });
    f.rpc.included = true;
    await f.service.reconcile(execution.transaction_id);
    const settlement = await f.response(w.id, 'settlement.requested.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in settlement);
    await settlements.handle(settlement);
    const committed = exchangeEventSchema.parse(
      (
        await ledger.outbox.findFirstOrThrow({
          where: {
            queue: QUEUES.wallet,
            payload: { path: ['operationId'], equals: w.id },
            AND: { payload: { path: ['type'], equals: 'settlement.committed.v1' } },
          },
        })
      ).payload,
    );
    await f.service.handle(committed);
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'executing');
    await db.withdrawal.update({ where: { id: w.id }, data: { next_check_at: new Date(0) } });
    await f.withdrawals.repairDue();
    await f.withdrawals.handle(await f.response(w.id, 'execution.attempt.updated.v1'));
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'settled');
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      1,
    );
  },
);

test(
  'destination that becomes exchange-owned after acceptance is blocked before hot authorization',
  { skip: !enabled },
  async () => {
    const f = await withdrawalFixture();
    const body = { ...f.request, destination: '0x' + 'be'.repeat(20) };
    const w = await f.reserve(body);
    const execute = await f.prepare(w.id);
    await db.wallet.create({
      data: {
        id: randomUUID(),
        external_id: randomUUID(),
        chain: 'ethereum',
        network: '11155111',
        seed_id: 'legacy-ownership-fixture',
        account: 120,
        path: "m/44'/60'/120'/0/0",
        address: body.destination.toUpperCase().replace('0X', '0x'),
        status: 'ready',
      },
    });
    await f.service.handle(execute);
    await f.withdrawals.handle(await f.response(w.id, 'withdrawal.plan.deferred.v1'));
    await f.release(w.id);
    assert.equal(
      await db.outbox.count({
        where: { queue: QUEUES.signer, payload: { path: ['operationId'], equals: w.id } },
      }),
      0,
    );
    assert.equal((await f.withdrawals.get(f.customerId, w.id)).state, 'cancelled');
  },
);

test(
  're-included older hot withdrawal gets fresh terminal proof while a newer authorized hot fence stays intact',
  { skip: !enabled },
  async () => {
    const first = await withdrawalFixture();
    const a = await first.reserve();
    await first.sign(a.id);
    await first.settle(a.id);
    const next = await withdrawalFixture();
    const b = await next.reserve();
    const action = await next.authorize(b.id);
    const old = await db.custodyExecution.findUniqueOrThrow({ where: { operation_id: a.id } }),
      newer = await db.custodyExecution.findUniqueOrThrow({ where: { operation_id: b.id } });
    first.rpc.canonicalBlock = replacementBlock;
    await first.service.reconcile(old.transaction_id);
    const reversal = await first.response(a.id, 'settlement.reverted.v1', QUEUES.ledger);
    assert.ok('schemaVersion' in reversal);
    await settlements.handle(reversal);
    first.rpc.block = replacementBlock;
    await first.service.reconcile(old.transaction_id);
    await first.settle(a.id);
    assert.equal((await first.withdrawals.get(first.customerId, a.id)).state, 'settled');
    const recovered = await db.custodyExecution.findUniqueOrThrow({
      where: { operation_id: a.id },
    });
    assert.equal(recovered.terminal_proof_revision, 3);
    assert.equal(recovered.ledger_ack_revision, 3);
    assert.equal(
      (await db.custodyExecution.findUniqueOrThrow({ where: { operation_id: b.id } })).retired_at,
      null,
    );
    assert.equal(
      await db.executionResourceClaim.count({ where: { execution_id: newer.id, active: true } }),
      1,
    );
    // An already authorized delivery may have signed before the domain pause; settle that same attempt.
    const signed = signer.execute(action);
    assert.equal(signed.type, 'transaction.custody.signed');
    next.rpc.signed = signed.signed;
    await next.service.handle(signed);
    await next.settle(b.id);
  },
);

async function fundingFixture() {
  // The preceding recovery test deliberately pauses this isolated fixture domain.
  await db.custodyDomain.update({ where: { id: settings.domainId }, data: { status: 'active' } });
  const f = await fixture();
  const management = await db.wallet.findFirstOrThrow({
    where: {
      custody_domain_id: settings.domainId,
      chain: 'ethereum',
      custody_role: 'management',
      account: 1,
    },
  });
  const certificate = {
    standard: 'erc20',
    chain: 'ethereum',
    network: '11155111',
    contract: '0x' + 'ae'.repeat(20),
    decimals: 6,
    certificateId: 'budget-fixture',
    semantics: 'exact-transfer',
    runtimeCodeHash: '0x' + 'ab'.repeat(32),
    upgradePolicy: 'immutable',
  } as const;
  const identity = {
    domain_id: settings.domainId,
    chain: 'ethereum',
    network: '11155111',
    asset_id: `token:ethereum:erc20:${certificate.contract}`,
  };
  await db.assetConfiguration.upsert({
    where: { domain_id_chain_network_asset_id: identity },
    update: {},
    create: {
      ...identity,
      standard: 'erc20',
      decimals: 6,
      symbol: 'TEST',
      name: 'Test transfer asset',
      contract_address: certificate.contract,
      minimum_credit_units: '1',
      minimum_sweep_units: '1',
      maximum_fee_units: '5000000000000000',
      policy_version: 'exchange-financial-v1',
      transfer_certificate: certificate,
      sweep_enabled: true,
    },
  });
  const request: TokenFeeRequest = {
    domainId: settings.domainId,
    resetEpoch: auth.resetEpoch,
    customerId: f.customerId,
    sourceWalletId: f.source.id,
    managementWalletId: management.id,
    sourceRegistryRevision: f.source.registry_revision,
    managementRegistryRevision: management.registry_revision,
    operationId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    certificate,
    kind: 'gas_funding',
    principalUnits: '1000000000000000',
    maximumFeeUnits: '100000000000000',
    maximumRentUnits: '0',
  };
  return { ...f, request, fees: new TokenFeesService(db, f.rpc) };
}

test(
  'token fee reservations are atomic and idempotent, and conflicting dependency payloads cannot replace an intent',
  { skip: !enabled },
  async () => {
    const f = await fundingFixture();
    const rows = await Promise.all([f.fees.reserve(f.request), f.fees.reserve(f.request)]);
    assert.equal(rows[0].id, rows[1].id);
    assert.equal(rows[0].reserved_units, '1100000000000000');
    await assert.rejects(
      f.fees.reserve({ ...f.request, principalUnits: '2000000000000000' }),
      /immutable/,
    );
    await assert.rejects(
      f.fees.reserve({
        ...f.request,
        generation: 2,
        operationId: randomUUID(),
        attemptId: randomUUID(),
      }),
      /outstanding/,
    );
    await assert.rejects(
      db.tokenFeeReservation.update({ where: { id: rows[0].id }, data: { principal_units: '2' } }),
      /immutable/,
    );
    await db.tokenFeeReservation.update({
      where: { id: rows[0].id },
      data: { state: 'uncertain' },
    });
    await assert.rejects(
      db.tokenFeeReservation.update({ where: { id: rows[0].id }, data: { state: 'released' } }),
      /cannot be released/,
    );
  },
);

test(
  'token fee liquidity includes other wallets pending claims even when each quote individually fits',
  { skip: !enabled },
  async () => {
    const a = await fundingFixture(),
      b = await fundingFixture();
    const left = await a.fees.reserve(a.request);
    b.rpc.balance =
      BigInt(left.reserved_units) +
      BigInt(b.request.principalUnits) +
      BigInt(b.request.maximumFeeUnits) -
      1n;
    await assert.rejects(b.fees.reserve(b.request), /liquidity/);
    assert.equal(
      await db.tokenFeeReservation.count({ where: { source_wallet_id: b.source.id } }),
      0,
    );
  },
);

test(
  'token funding fails closed for an unready registry, changed certificate and operation caps',
  { skip: !enabled },
  async () => {
    const f = await fundingFixture();
    await assert.rejects(f.fees.reserve({ ...f.request, sourceRegistryRevision: 2 }), /authority/);
    await assert.rejects(
      f.fees.reserve({
        ...f.request,
        certificate: { ...f.request.certificate, certificateId: 'changed' },
      }),
      /authority/,
    );
    await assert.rejects(
      f.fees.reserve({ ...f.request, principalUnits: '5000000000000001' }),
      /per-operation/,
    );
    f.rpc.balance = 1n;
    await assert.rejects(f.fees.reserve(f.request), /liquidity/);
  },
);

test(
  'rolling token funding budget counts settled actual costs and excludes only settlements older than 24 hours',
  { skip: !enabled },
  async () => {
    const recent = await fundingFixture();
    const held = await recent.fees.reserve({
      ...recent.request,
      principalUnits: '4900000000000000',
    });
    await db.tokenFeeReservation.update({
      where: { id: held.id },
      data: { state: 'settled', actual_units: held.reserved_units, settled_at: new Date() },
    });
    await assert.rejects(
      recent.fees.reserve({
        ...recent.request,
        generation: 2,
        operationId: randomUUID(),
        attemptId: randomUUID(),
        principalUnits: '5000000000000000',
      }),
      /Rolling fee budget/,
    );
    await assert.rejects(
      db.tokenFeeReservation.update({ where: { id: held.id }, data: { actual_units: '0' } }),
      /settlement is immutable/,
    );
    await assert.rejects(
      db.tokenFeeReservation.update({
        where: { id: held.id },
        data: { state: 'released', actual_units: null, settled_at: null },
      }),
      /Invalid fee dependency transition/,
    );
    const old = await fundingFixture(),
      r = old.request;
    await db.tokenFeeReservation.create({
      data: {
        id: randomUUID(),
        domain_id: r.domainId,
        reset_epoch: r.resetEpoch,
        customer_id: r.customerId,
        source_wallet_id: r.sourceWalletId,
        management_wallet_id: r.managementWalletId,
        chain: r.certificate.chain,
        network: r.certificate.network,
        dependency_key: executionDigest([
          r.domainId,
          r.resetEpoch,
          r.sourceWalletId,
          `token:ethereum:erc20:${r.certificate.standard === 'erc20' ? r.certificate.contract : ''}`,
          r.generation,
          r.kind,
        ]),
        request_digest: executionDigest(r),
        kind: r.kind,
        principal_units: '4900000000000000',
        maximum_fee_units: '100000000000000',
        maximum_rent_units: '0',
        reserved_units: '5000000000000000',
        state: 'settled',
        actual_units: '5000000000000000',
        created_at: new Date(Date.now() - 26 * 3600000),
        settled_at: new Date(Date.now() - 25 * 3600000),
        request: { ...r, principalUnits: '4900000000000000' },
      },
    });
    const next = await old.fees.reserve({
      ...r,
      generation: 2,
      operationId: randomUUID(),
      attemptId: randomUUID(),
      principalUnits: '5000000000000000',
    });
    assert.equal(next.state, 'reserved');
  },
);
