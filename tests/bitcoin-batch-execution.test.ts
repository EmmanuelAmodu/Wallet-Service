import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { batchWalletFixture, BatchHoldInput } from './helpers/batch-wallet-fixture.js';
import { isolatedDatabase, testMnemonic } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { SettlementsService } from '../apps/ledger/src/settlements/settlements.service.js';
import { BitcoinBatchExecutionService } from '../apps/wallet/src/execution/bitcoin-batch-execution.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import { Chain, SignedTransaction } from '../packages/shared/src/contracts.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { messageSchema, Message, QUEUES, MessageAuth } from '../packages/queue/src/messages.js';
import { PayoutBatchLedgerCommand } from '../packages/shared/src/bitcoin-batch-contracts.js';
import { ExecutionSettings } from '../apps/wallet/src/config/execution.config.js';
import { WithdrawalsService } from '../apps/wallet/src/withdrawals/withdrawals.service.js';
import { ExchangeMessagingService } from '../apps/wallet/src/exchange-messaging/exchange-messaging.service.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import { retryFailedConsumerJobs } from '../packages/queue/src/consumer-repair.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_LEDGER_DATABASE_URL;
const asset = { chain: 'bitcoin' as const, network: 'regtest', assetId: 'token:bitcoin:native' };

async function fixture(memberCount = 3) {
  const isolated = await isolatedDatabase(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger'),
    ledger = new LedgerPrismaService({ databaseUrl: isolated.url });
  const journal = new JournalService(new AccountsService());
  let w: Awaited<ReturnType<typeof batchWalletFixture>> | undefined, core: SigningCore | undefined;
  const spec = (domainId: string, type: AccountSpec['type'], ownerId: string): AccountSpec => ({
    domainId,
    ...asset,
    type,
    ownerId,
    ownerKind: type.startsWith('customer_')
      ? 'customer'
      : type.startsWith('custody_')
        ? 'wallet'
        : 'exchange',
    normalSide: type.startsWith('customer_') ? 'credit' : 'debit',
  });
  try {
    w = await batchWalletFixture(
      'bitcoin',
      async (input: BatchHoldInput) => {
        await ledger.exchangeWallet.upsert({
          where: { wallet_id: input.hotId },
          update: {},
          create: {
            wallet_id: input.hotId,
            domain_id: input.domainId,
            reset_epoch: input.resetEpoch,
            chain: 'bitcoin',
            network: 'regtest',
            address: input.address,
            address_key: input.address,
            role: 'hot',
            account: 0,
            registry_revision: 1,
          },
        });
        await ledger.exchangeCustomer.create({
          data: { customer_id: input.customerId, domain_id: input.domainId },
        });
        await ledger.$transaction((tx) =>
          journal.post(tx, {
            key: randomUUID(),
            domainId: input.domainId,
            revision: 1,
            kind: 'fixture.credit',
            postings: [
              {
                account: spec(input.domainId, 'custody_hot', input.hotId),
                side: 'debit',
                amount: 100000n,
              },
              {
                account: spec(input.domainId, 'customer_available', input.customerId),
                side: 'credit',
                amount: 100000n,
              },
            ],
          }),
        );
        const reserve = exchangeEventSchema.parse({
          eventId: randomUUID(),
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          resetEpoch: input.resetEpoch,
          domainId: input.domainId,
          correlationId: input.operationId,
          causationId: null,
          aggregateId: input.operationId,
          revision: 1,
          customerId: input.customerId,
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          policyVersion: 'exchange-financial-v1',
          type: 'withdrawal.reserve.requested.v1',
          data: {
            hotWalletId: input.hotId,
            destination: input.destination,
            principal: { asset, amount: '1000' },
            amounts: [{ asset, amount: '1000' }],
            quoteExpiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        });
        await new ReservationsService(ledger, journal, { resetEpoch: input.resetEpoch }).handle(
          reserve,
        );
        return (
          await ledger.withdrawalReservation.findUniqueOrThrow({
            where: { operation_id: input.operationId },
          })
        ).id;
      },
      memberCount,
    );
    const wallet = w;
    await w.db.assetConfiguration.update({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: w.manifest.domainId,
          ...{ chain: 'bitcoin', network: 'regtest', asset_id: asset.assetId },
        },
      },
      data: { observation_enabled: true, credit_enabled: true },
    });
    core = await SigningCore.create(testMnemonic, w.config.seedId, '11155111', undefined, {
      domainId: w.manifest.domainId,
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
    const authority = generateKeyPairSync('ed25519'),
      attestor = generateKeyPairSync('ed25519');
    const settings: ExecutionSettings = {
      enabled: true,
      withdrawalsEnabled: true,
      bitcoinBatchesEnabled: true,
      authorityPrivateKey: authority.privateKey,
      signerPublicKey: attestor.publicKey,
      pollIntervalMs: 1000,
    };
    const rpc = new (class extends ChainRpcService {
      signed?: SignedTransaction;
      block = 'b'.repeat(64);
      included = false;
      outage = false;
      override async call(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
        if (this.outage) throw new RpcFailure();
        if (method === 'getrawtransaction') {
          if (!this.signed) throw new RpcFailure(-5);
          return {
            txid: this.signed.txHash,
            hex: this.signed.raw,
            ...(this.included ? { blockhash: this.block } : {}),
          };
        }
        if (method === 'getblockheader') return { hash: this.block, height: 101, confirmations: 6 };
        if (method === 'getblockhash') return this.block;
        return wallet.rpc.call(chain, method, params);
      }
    })({
      ethereumChainId: 'unused',
      solanaGenesisHash: 'unused',
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
    const service = () =>
      new BitcoinBatchExecutionService(
        wallet.db,
        wallet.auth,
        wallet.config,
        settings,
        wallet.custody,
        wallet.service,
        rpc,
        acceptanceRollout,
      );
    const settlements = new SettlementsService(
      ledger,
      journal,
      new ReservationsService(ledger, journal, { resetEpoch: w.auth.resetEpoch }),
    );
    const signing = new SigningService(
      core,
      new CustodySigningPolicy(
        {
          enabled: true,
          withdrawalsEnabled: true,
          bitcoinBatchesEnabled: true,
          domainId: w.manifest.domainId,
          resetEpoch: w.auth.resetEpoch,
          authorityPublicKey: authority.publicKey,
          attestationPrivateKey: attestor.privateKey,
        },
        core,
      ),
    );
    const latestWallet = async (type: Message['type']) =>
      messageSchema.parse(
        (
          await wallet.db.outbox.findMany({
            where: {
              queue: type === 'payout.batch.sign' ? QUEUES.signer : QUEUES.ledger,
              payload: { path: ['type'], equals: type },
            },
            orderBy: { created_at: 'desc' },
          })
        )[0].payload,
      );
    const deliverLedger = async (command: PayoutBatchLedgerCommand) => {
      await settlements.handleBatch(command);
      const rows = await ledger.outbox.findMany({
        where: { payload: { path: ['type'], equals: 'payout.batch.ledger.result' } },
        orderBy: { created_at: 'desc' },
      });
      await service().handle(messageSchema.parse(rows[0].payload));
    };
    return {
      w: wallet,
      ledger,
      settings,
      journal,
      rpc,
      service,
      signing,
      settlements,
      latestWallet,
      deliverLedger,
      balance: (type: AccountSpec['type'], id: string) =>
        ledger.$transaction((tx) => journal.balance(tx, spec(wallet.manifest.domainId, type, id))),
      close: async () => {
        core!.close();
        await wallet.close();
        await ledger.$disconnect();
        await isolated.drop();
      },
    };
  } catch (error) {
    core?.close();
    await w?.close();
    await ledger.$disconnect();
    await isolated.drop();
    throw error;
  }
}

test(
  'Wallet batch waits for Ledger then signs, preserves aggregate membership and completes all original withdrawals only after fresh accounting/canonical proof',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const id = f.w.manifest.batchId;
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      await f.service().start(id);
      await f.service().start(id);
      assert.equal(
        await f.w.db.outbox.count({
          where: { queue: QUEUES.signer, payload: { path: ['type'], equals: 'payout.batch.sign' } },
        }),
        0,
      );
      await assert.rejects(f.w.service.releaseUnsigned(id), /unsigned dissolution/);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.prepare')) as PayoutBatchLedgerCommand,
      );
      const command = await f.latestWallet('payout.batch.sign');
      const result = f.signing.execute(command);
      assert(result.type === 'payout.batch.signed');
      await f.service().handle(result);
      await f.service().handle(result);
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), 1);
      f.rpc.signed = result.signed;
      f.rpc.included = true;
      await f.service().reconcile(id);
      assert.equal(
        (await f.w.db.bitcoinBatchExecution.findUniqueOrThrow({ where: { batch_id: id } })).state,
        'settlement_pending',
      );
      for (const m of f.w.manifest.members)
        assert.equal(
          (await f.w.db.withdrawal.findUniqueOrThrow({ where: { id: m.operationId } })).state,
          'executing',
        );
      const settlement = (await f.latestWallet(
        'payout.batch.ledger.settle',
      )) as PayoutBatchLedgerCommand;
      await f.settlements.handleBatch(settlement);
      const individual = await f.ledger.outbox.findFirstOrThrow({
        where: {
          queue: QUEUES.wallet,
          payload: { path: ['type'], equals: 'settlement.committed.v1' },
        },
      });
      assert.equal(await f.service().handle(messageSchema.parse(individual.payload)), true);
      // One member notification must not create a partially settled Wallet projection.
      for (const member of f.w.manifest.members)
        assert.equal(
          (await f.w.db.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } })).state,
          'executing',
        );
      await f.deliverLedger(settlement);
      // The Ledger ack alone is insufficient to retire the hot source.
      assert.equal(
        (await f.w.db.withdrawalBatchDraft.findUniqueOrThrow({ where: { id } })).state,
        'planned',
      );
      await f.service().reconcile(id);
      assert.equal(
        (await f.w.db.withdrawalBatchDraft.findUniqueOrThrow({ where: { id } })).state,
        'completed',
      );
      assert.equal(await f.w.db.withdrawalBatchResource.count({ where: { active: true } }), 1);
      const beforeStable = await f.w.db.withdrawal.findMany({
        where: { batch_draft_id: id },
        orderBy: { id: 'asc' },
      });
      const history = await f.w.db.bitcoinBatchExecutionEvent.count({ where: { batch_id: id } });
      await f.service().reconcile(id);
      assert.deepEqual(
        await f.w.db.withdrawal.findMany({ where: { batch_draft_id: id }, orderBy: { id: 'asc' } }),
        beforeStable,
      );
      assert.equal(
        await f.w.db.bitcoinBatchExecutionEvent.count({ where: { batch_id: id } }),
        history,
      );
      const fee = BigInt(
        (settlement as Extract<PayoutBatchLedgerCommand, { type: 'payout.batch.ledger.settle' }>)
          .actualFeeUnits,
      );
      assert.equal(await f.balance('custody_hot', f.w.hot.id), 300000n - 3000n - fee);
      for (const m of f.w.manifest.members) {
        const row = await f.w.db.withdrawal.findUniqueOrThrow({ where: { id: m.operationId } });
        assert.equal(row.state, 'settled');
        assert.equal(row.reservation_id, m.reservationId);
        assert.equal(row.transaction_hash, result.signed.txHash);
      }
      const before = await f.ledger.journalBatch.count();
      f.rpc.outage = true;
      await assert.rejects(f.service().reconcile(id));
      f.rpc.outage = false;
      assert.equal(await f.ledger.journalBatch.count(), before);
      f.rpc.block = 'c'.repeat(64);
      await f.service().reconcile(id);
      assert.equal(
        (await f.w.db.custodyDomain.findUniqueOrThrow({ where: { id: f.w.manifest.domainId } }))
          .status,
        'paused',
      );
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.revert')) as PayoutBatchLedgerCommand,
      );
      for (const m of f.w.manifest.members)
        assert.equal(await f.balance('customer_reserved', m.customerId), 1000n);
      await f.service().reconcile(id);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.settle')) as PayoutBatchLedgerCommand,
      );
      await f.service().reconcile(id);
      assert.equal(
        (await f.w.db.bitcoinBatchExecution.findUniqueOrThrow({ where: { batch_id: id } }))
          .revision,
        3,
      );
      assert.equal(await f.balance('custody_hot', f.w.hot.id), 300000n - 3000n - fee);
      assert.equal(await f.w.db.withdrawalBatchResource.count({ where: { active: true } }), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'forty executing batch members cannot starve the individual withdrawal recovery page',
  { skip: !enabled },
  async () => {
    const f = await fixture(41);
    try {
      const waiting = f.w.manifest.members.pop()!;
      const id = f.w.manifest.batchId;
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      await f.service().start(id);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.prepare')) as PayoutBatchLedgerCommand,
      );
      await f.service().handle(f.signing.execute(await f.latestWallet('payout.batch.sign')));
      await f.w.db.withdrawal.updateMany({
        where: { batch_draft_id: id },
        data: { next_check_at: new Date(0) },
      });
      const due = new Date(Date.now() - 1000);
      await f.w.db.withdrawal.update({
        where: { id: waiting.operationId },
        data: { next_check_at: due },
      });
      const withdrawals = new WithdrawalsService(
        f.w.db,
        f.w.custody,
        new ExchangeMessagingService(f.w.db, f.w.auth),
        f.w.auth,
        f.w.config,
        f.settings,
        acceptanceRollout,
        f.w.service,
      );
      await withdrawals.repairDue();
      const refreshed = await f.w.db.withdrawal.findUniqueOrThrow({
        where: { id: waiting.operationId },
      });
      assert(refreshed.next_check_at > due);
      // The busy source remains fenced; recovery services this row without dispatching it.
      assert.equal(refreshed.state, 'queued');
      assert.equal(refreshed.attempt_id, null);
      assert.equal(
        await f.w.db.withdrawal.count({
          where: { batch_draft_id: id, state: 'executing', next_check_at: new Date(0) },
        }),
        40,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'customer cancellation atomically dissolves an unadmitted draft and releases only that original customer hold',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const id = f.w.manifest.batchId,
        target = f.w.manifest.members[0];
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      const withdrawals = new WithdrawalsService(
        f.w.db,
        f.w.custody,
        new ExchangeMessagingService(f.w.db, f.w.auth),
        f.w.auth,
        f.w.config,
        f.settings,
        acceptanceRollout,
        f.w.service,
      );
      await withdrawals.cancel(target.customerId, target.operationId);
      assert.equal(
        (await f.w.db.withdrawalBatchDraft.findUniqueOrThrow({ where: { id } })).state,
        'released',
      );
      assert.equal(await f.w.db.withdrawalBatchResource.count({ where: { active: true } }), 0);
      const release = await f.latestWallet('reservation.release.requested.v1');
      assert('schemaVersion' in release);
      await new ReservationsService(f.ledger, f.journal, {
        resetEpoch: f.w.auth.resetEpoch,
      }).handle(release);
      assert.equal(await f.balance('customer_reserved', target.customerId), 0n);
      assert.equal(await f.balance('customer_available', target.customerId), 100000n);
      for (const member of f.w.manifest.members.slice(1)) {
        const w = await f.w.db.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
        assert.equal(w.state, 'queued');
        assert.equal(w.attempt_id, null);
        assert.equal(w.reservation_id, member.reservationId);
        assert.equal(await f.balance('customer_reserved', member.customerId), 1000n);
      }
      await assert.rejects(f.service().start(id), /closed|admission changed/);
    } finally {
      await f.close();
    }
  },
);

test(
  'delayed successful signing supersedes an expired retry rejection without discarding either receipt or releasing original holds',
  { skip: !enabled },
  async (t) => {
    const f = await fixture();
    try {
      const id = f.w.manifest.batchId;
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      await f.service().start(id);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.prepare')) as PayoutBatchLedgerCommand,
      );
      const command = await f.latestWallet('payout.batch.sign');
      assert(command.type === 'payout.batch.sign');
      const successful = f.signing.execute(command);
      assert(successful.type === 'payout.batch.signed');
      let rejected: Message;
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(command.preparation.expiresAt) + 1 });
      try {
        rejected = f.signing.execute(command);
      } finally {
        t.mock.timers.reset();
      }
      assert(rejected.type === 'payout.batch.rejected');
      assert.equal(rejected.commandDigest, executionDigest(command));
      await f.service().handle(rejected);
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), 0);
      for (const m of f.w.manifest.members)
        assert.equal(await f.balance('customer_reserved', m.customerId), 1000n);
      await f.service().handle(successful);
      await f.service().handle(rejected);
      const row = await f.w.db.bitcoinBatchExecution.findUniqueOrThrow({ where: { batch_id: id } });
      assert.deepEqual(row.signed, successful.signed);
      assert.equal(await f.w.db.bitcoinBatchSignerResult.count(), 2);
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), 1);
      await assert.rejects(
        f.w.db.bitcoinBatchSignerResult.deleteMany({ where: { batch_id: id } }),
        /immutable/,
      );
    } finally {
      t.mock.timers.reset();
      await f.close();
    }
  },
);

test(
  'automatic scheduling excludes frozen members, claims eligible held withdrawals and queues only Ledger approval',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      await f.w.db.exchangeCustomer.update({
        where: { customer_id: f.w.manifest.members[0].customerId },
        data: { state: 'frozen' },
      });
      await f.service().repairDue();
      const rows = await f.w.db.bitcoinBatchExecution.findMany();
      assert.equal(rows.length, 1);
      const draft = await f.w.db.withdrawalBatchDraft.findUniqueOrThrow({
        where: { id: rows[0].batch_id },
      });
      const members = (draft.manifest as { members: { customerId: string }[] }).members;
      assert.equal(members.length, 2);
      assert(members.every((m) => m.customerId !== f.w.manifest.members[0].customerId));
      assert.equal(
        await f.w.db.outbox.count({
          where: { queue: QUEUES.signer, payload: { path: ['type'], equals: 'payout.batch.sign' } },
        }),
        0,
      );
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), 0);
      assert.equal(
        (
          await f.w.db.withdrawal.findUniqueOrThrow({
            where: { id: f.w.manifest.members[0].operationId },
          })
        ).state,
        'queued',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'batch admission is gated and changed signing results cannot replace retained exact evidence or release original holds',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const id = f.w.manifest.batchId;
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      f.settings.bitcoinBatchesEnabled = false;
      await assert.rejects(f.service().start(id), /disabled/);
      assert.equal(await f.w.db.bitcoinBatchExecution.count(), 0);
      f.settings.bitcoinBatchesEnabled = true;
      await f.service().start(id);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.prepare')) as PayoutBatchLedgerCommand,
      );
      const command = await f.latestWallet('payout.batch.sign');
      const result = f.signing.execute(command);
      assert(result.type === 'payout.batch.signed');
      const changed = structuredClone(result);
      changed.signed.txHash = 'f'.repeat(64);
      await assert.rejects(f.service().handle(changed));
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), 0);
      await f.service().handle(result);
      await assert.rejects(
        f.w.db.bitcoinBatchExecution.update({ where: { batch_id: id }, data: { signed: {} } }),
        /immutable/,
      );
      const commandId = randomUUID();
      await f.service().retrySigned(id, commandId);
      const count = await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } });
      await f.service().retrySigned(id, commandId);
      assert.equal(await f.w.db.outbox.count({ where: { queue: QUEUES.broadcast } }), count);
      const inspected = await f.service().inspect(id);
      assert.equal(inspected.transactionHash, result.signed.txHash);
      assert(inspected.history.length > 0);
      await assert.rejects(
        f.w.db.bitcoinBatchExecutionEvent.deleteMany({ where: { batch_id: id } }),
        /immutable/,
      );
      await assert.rejects(f.w.service.releaseUnsigned(id));
      for (const m of f.w.manifest.members)
        assert.equal(await f.balance('customer_reserved', m.customerId), 1000n);
    } finally {
      await f.close();
    }
  },
);

test(
  'failed-job repair recovers original batch signing commands and attested results using their bound scope',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const id = f.w.manifest.batchId;
      await f.w.service.claim(f.w.manifest);
      await f.w.service.prepareBitcoin(id);
      await f.service().start(id);
      await f.deliverLedger(
        (await f.latestWallet('payout.batch.ledger.prepare')) as PayoutBatchLedgerCommand,
      );
      const command = await f.latestWallet('payout.batch.sign'),
        result = f.signing.execute(command);
      assert(result.type === 'payout.batch.signed');
      const old = structuredClone(result);
      old.signerAttestation.claims.resetEpoch = 'old';
      const jobs = [command, result, old].map((payload) => {
        const jobId = randomUUID(),
          data = f.w.auth.seal(payload, jobId);
        return {
          id: jobId,
          name: payload.type,
          data,
          getState: async () => 'failed',
          retry: async () => {
            retried.push(jobId);
            assert.equal(data.payload, payload);
          },
        };
      });
      const oldEnvelope = { ...jobs[1], id: randomUUID() };
      oldEnvelope.data = new MessageAuth('q'.repeat(64), 'old').seal(result, oldEnvelope.id);
      const retried: string[] = [];
      const queue = { getFailed: async () => [...jobs, oldEnvelope] };
      assert.deepEqual(
        await retryFailedConsumerJobs(
          queue as unknown as import('bullmq').Queue,
          f.w.auth,
          f.w.manifest.domainId,
        ),
        { retried: 2, stale: 2 },
      );
      assert.deepEqual(retried, [jobs[0].id, jobs[1].id]);
    } finally {
      await f.close();
    }
  },
);
