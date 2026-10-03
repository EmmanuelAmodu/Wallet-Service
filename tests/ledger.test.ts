import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { ActivityWorkflowService } from '../apps/activity-listener/src/activity-workflow.service.js';
import { ActivityListenerConfig } from '../apps/activity-listener/src/config/activity-listener.config.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { LedgerProcessor } from '../apps/ledger/src/ledger.processor.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { migrate } from '../scripts/migrate.js';
import { LedgerActivity, ProcessorActivity } from '../packages/shared/src/activity-contracts.js';
import { connection } from '../packages/queue/src/messaging.module.js';
import { MessageAuth, Message, QUEUES } from '../packages/queue/src/messages.js';
import { Job } from 'bullmq';

const enabled = !!process.env.TEST_LEDGER_DATABASE_URL;
const db = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const walletIds = [randomUUID(), randomUUID()];
const tenantId = `ledger-test-${randomUUID()}`;
const walletAddresses = [randomBytes(20).toString('hex'), randomBytes(20).toString('hex')].map(
  (address) => `0x${address}`,
);
const identifiers = Array.from({ length: 8 }, () => `transaction:ethereum:${randomUUID()}`);
let service: LedgerService;

test('ledger processor returns a JSON-safe void acknowledgement after commit', async () => {
  const auth = new MessageAuth('f'.repeat(64));
  const message = {
    type: 'ledger.activity.update' as const,
    activity: activity(0, 'observed', 'block'),
  };
  const jobId = randomUUID();
  const job = {
    id: jobId,
    name: message.type,
    data: auth.seal(message, jobId),
  } as Job;
  const processor = new LedgerProcessor(
    {
      applyActivity: async () => ({ created_at: new Date(), block_height: 1n }),
    } as unknown as LedgerService,
    auth,
  );

  assert.equal(await processor.process(job), undefined);
});

test(
  'ActivityListener to Ledger BullMQ path commits an exact large balance and completes the job',
  { skip: !enabled || !process.env.TEST_REDIS_URL, timeout: 15000 },
  async () => {
    const asset = `token:ethereum:zz-integration-${randomUUID()}`;
    const before = BigInt(
      (await service.balances(walletIds[0], tenantId)).balances.find(
        (balance) => balance.asset === asset,
      )?.confirmed ?? '0',
    );
    const prefix = `ledger-flow-${randomUUID()}`;
    const options = { connection: connection(process.env.TEST_REDIS_URL!), prefix };
    const activityQueue = new Queue(QUEUES.activity, options);
    const ledgerQueue = new Queue(QUEUES.ledger, options);
    const auth = new MessageAuth('9'.repeat(64));
    const processor = new LedgerProcessor(service, auth);
    const worker = new Worker(QUEUES.ledger, (job) => processor.process(job), options);
    const identifier = `transaction:ethereum:${randomUUID()}`;
    const source: ProcessorActivity = {
      identifier,
      completedAtTimestamp: 1000,
      metadata: {},
      status: 'success',
      transfers: [],
      tokenIdentifiers: [asset],
      fee: { amount: 0, feePayer: [] },
      balanceChanges: [
        {
          wallet: `wallet:ethereum:${walletAddresses[0]}`,
          changes: [{ token: asset, amount: '-1000000000000000000001' }],
        },
      ],
    };
    const config: ActivityListenerConfig = {
      pubsubProjectId: 'test',
      pubsubSubscription: 'test-subscription',
      pubsubApiEndpoint: undefined,
      finalityPollMs: 30000,
      finalityMaxPolls: 3,
      reconciliationPollMs: 300000,
    };
    const listener = new ActivityWorkflowService(
      {
        networkIdentity: () => '11155111',
        observeTransaction: async () => ({
          state: 'finalized' as const,
          blockHash: '0xflow-block',
          blockHeight: '10',
        }),
      } as never,
      auth,
      activityQueue,
      ledgerQueue,
      config,
    );
    try {
      await worker.waitUntilReady();
      await listener.receive(source, 'pubsub-ledger-integration');
      let completed: Job | undefined;
      const deadline = Date.now() + 10000;
      while (!completed && Date.now() < deadline) {
        const jobs = await ledgerQueue.getJobs(['completed'], 0, 100);
        completed = jobs.find((job) => {
          const message = auth.open(job.data, job.id!, job.name) as Message;
          return (
            message.type === 'ledger.activity.update' && message.activity.identifier === identifier
          );
        });
        if (!completed) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(completed, 'Ledger queue job should complete');
      assert.equal(completed.returnvalue, null);
      const after = BigInt(
        (await service.balances(walletIds[0], tenantId)).balances.find(
          (balance) => balance.asset === asset,
        )!.confirmed,
      );
      assert.equal(after, before - 1_000_000_000_000_000_000_001n);
      assert.equal(
        (await db!.ledgerActivity.findUniqueOrThrow({ where: { identifier } })).state,
        'finalized',
      );
    } finally {
      await worker.close();
      await activityQueue.obliterate({ force: true });
      await ledgerQueue.obliterate({ force: true });
      await activityQueue.close();
      await ledgerQueue.close();
    }
  },
);

before(async () => {
  if (!db) return;
  await migrate(process.env.TEST_LEDGER_DATABASE_URL!, 'ledger');
  await db.ledgerAccount.updateMany({
    where: { chain: 'ethereum', network: '11155111' },
    data: { last_entry_id: null },
  });
  await db.ledgerEntry.deleteMany({
    where: { account: { chain: 'ethereum', network: '11155111' } },
  });
  await db.ledgerActivity.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerAccount.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerWallet.deleteMany({ where: { tenant_id: { startsWith: 'ledger-test-' } } });
  service = new LedgerService(db);
  await Promise.all(
    walletIds.map((walletId, index) =>
      service.registerWallet({
        walletId,
        tenantId,
        chain: 'ethereum',
        network: '11155111',
        address: walletAddresses[index],
      }),
    ),
  );
});

after(async () => {
  if (!db) return;
  await db.ledgerAccount.updateMany({
    where: { chain: 'ethereum', network: '11155111' },
    data: { last_entry_id: null },
  });
  await db.ledgerEntry.deleteMany({
    where: { account: { chain: 'ethereum', network: '11155111' } },
  });
  await db.ledgerActivity.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  await db.ledgerAccount.deleteMany({ where: { chain: 'ethereum', network: '11155111' } });
  const litecoinAccounts = await db.ledgerAccount.findMany({
    where: { chain: 'litecoin', network: 'mainnet' },
    select: { account_key: true },
  });
  const litecoinAccountKeys = litecoinAccounts.map((account) => account.account_key);
  if (litecoinAccountKeys.length) {
    await db.ledgerAccount.updateMany({
      where: { account_key: { in: litecoinAccountKeys } },
      data: { last_entry_id: null },
    });
    await db.ledgerEntry.deleteMany({ where: { account_key: { in: litecoinAccountKeys } } });
    await db.ledgerAccount.deleteMany({ where: { account_key: { in: litecoinAccountKeys } } });
  }
  await db.ledgerActivity.deleteMany({ where: { chain: 'litecoin', network: 'mainnet' } });
  await db.ledgerWallet.deleteMany({ where: { tenant_id: tenantId } });
  await db.$disconnect();
});

function activity(
  index: number,
  state: LedgerActivity['state'],
  blockHash: string,
  observationSequence = '0',
  canonicalReconciliation = false,
): LedgerActivity {
  return {
    identifier: identifiers[index],
    chain: 'ethereum',
    network: '11155111',
    transactionHash: identifiers[index].split(':').at(-1)!,
    sourceStatus: 'success',
    state,
    completedAtTimestamp: 1000,
    observationSequence,
    canonicalReconciliation,
    blockHash,
    blockHeight: '10',
    changes: [
      {
        wallet: `wallet:ethereum:${walletAddresses[0]}`,
        asset: 'token:ethereum:native',
        amount: '-100',
      },
      {
        wallet: `wallet:ethereum:${walletAddresses[1]}`,
        asset: 'token:ethereum:native',
        amount: '100',
      },
    ],
  };
}

test(
  'ledger applies events idempotently, promotes provisional balances, and reverses reorged postings',
  { skip: !enabled },
  async () => {
    const first = activity(0, 'observed', '0xblock-a');
    await service.applyActivity(first);
    await service.applyActivity(first);
    let entries = await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } });
    assert.equal(entries, 2);
    const openingJournal = await db!.ledgerEntry.findMany({
      where: { activity_identifier: identifiers[0], revision: 0 },
    });
    const debits = openingJournal
      .filter((entry) => entry.side === 'debit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    const credits = openingJournal
      .filter((entry) => entry.side === 'credit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    assert.equal(debits.toString(), credits.toString());
    assert.equal(debits.toString(), '100');
    assert(openingJournal.every((entry) => entry.balance_after !== null));
    let balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '0');
    assert.equal(balances.balances[0].provisional, '-100');

    await service.applyActivity({
      ...first,
      state: 'finalized',
      observationSequence: '1',
      canonicalReconciliation: true,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-100');
    assert.equal(balances.balances[0].provisional, '0');
    entries = await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } });
    assert.equal(entries, 6);
    await service.applyActivity({
      ...first,
      state: 'finalized',
      observationSequence: '1',
      canonicalReconciliation: true,
    });
    assert.equal(
      await db!.ledgerEntry.count({ where: { activity_identifier: identifiers[0] } }),
      entries,
    );
    const accounts = await db!.ledgerAccount.findMany({
      where: { wallet_id: { in: walletIds }, asset: 'token:ethereum:native' },
    });
    for (const account of accounts) {
      const chain = await db!.ledgerEntry.findMany({
        where: { account_key: account.account_key },
        orderBy: { sequence: 'asc' },
      });
      let previousBalance = new Prisma.Decimal(0);
      for (let index = 0; index < chain.length; index++) {
        assert.equal(chain[index].previous_entry_id, chain[index - 1]?.id ?? null);
        assert.equal(chain[index].next_entry_id, chain[index + 1]?.id ?? null);
        const normalDelta =
          chain[index].side === account.normal_side
            ? chain[index].amount
            : chain[index].amount.negated();
        previousBalance = previousBalance.plus(normalDelta);
        assert.equal(chain[index].balance_after.toString(), previousBalance.toString());
      }
      assert.equal(account.last_entry_id, chain.at(-1)?.id);
    }
    await service.applyActivity({ ...first, state: 'attention', observationSequence: '2' });
    assert.equal(
      (await db!.ledgerActivity.findUniqueOrThrow({ where: { identifier: identifiers[0] } })).state,
      'finalized',
    );
    await service.applyActivity({
      ...first,
      state: 'observed',
      observationSequence: '3',
      blockHash: undefined,
      blockHeight: undefined,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-100');
    assert.equal(balances.balances[0].provisional, '0');

    const second = activity(1, 'observed', '0xblock-b');
    await service.applyActivity(second);
    await service.applyActivity({ ...second, state: 'attention', observationSequence: '1' });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-100');
    await service.applyActivity({ ...second, observationSequence: '2' });
    await service.applyActivity({
      ...second,
      state: 'finalized',
      observationSequence: '3',
      canonicalReconciliation: true,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-200');
    assert.equal(balances.balances[0].provisional, '0');

    await service.applyActivity(activity(3, 'attention', '0xblock-e'));
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].confirmed, '-200');
    assert.equal(balances.balances[0].provisional, '-100');

    const third = activity(2, 'observed', '0xblock-c');
    await service.applyActivity(third);
    await service.applyActivity({
      ...third,
      blockHash: '0xblock-d',
      observationSequence: '1',
      canonicalReconciliation: true,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-200');
    await service.applyActivity({
      ...third,
      state: 'reverted',
      blockHash: '0xblock-d',
      changes: [],
      observationSequence: '2',
      canonicalReconciliation: true,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(balances.balances[0].provisional, '-100');

    const feeActivity = activity(4, 'observed', '0xblock-fee');
    feeActivity.changes[0].amount = '-105';
    await service.applyActivity(feeActivity);
    const feeJournal = await db!.ledgerEntry.findMany({
      where: { activity_identifier: identifiers[4], revision: 0 },
    });
    const feeDebits = feeJournal
      .filter((entry) => entry.side === 'debit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    const feeCredits = feeJournal
      .filter((entry) => entry.side === 'credit')
      .reduce((total, entry) => total.plus(entry.amount), new Prisma.Decimal(0));
    assert.equal(feeDebits.toString(), feeCredits.toString());
    assert.equal(feeDebits.toString(), '105');
    const clearingEntry = feeJournal.find((entry) => entry.account_kind === 'clearing');
    assert.equal(clearingEntry?.side, 'debit');
    assert.equal(clearingEntry?.amount.toString(), '5');

    balances = await service.balances(walletIds[0], tenantId);
    const beforeLargePostings = BigInt(balances.balances[0].provisional);
    const large = activity(5, 'observed', '0xblock-large');
    large.changes[0].amount = '-1000000000000000000000';
    large.changes[1].amount = '1000000000000000000000';
    await service.applyActivity(large);
    const unit = activity(6, 'observed', '0xblock-unit');
    unit.changes[0].amount = '-1';
    unit.changes[1].amount = '1';
    await service.applyActivity(unit);
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(
      BigInt(balances.balances[0].provisional),
      beforeLargePostings - 1_000_000_000_000_000_000_000n - 1n,
    );

    const confirmedBeforeFinality = BigInt(balances.balances[0].confirmed);
    const finalized = activity(7, 'finalized', '0xcanonical-a', '5');
    await service.applyActivity(finalized);
    balances = await service.balances(walletIds[0], tenantId);
    const confirmedAfterFinality = BigInt(balances.balances[0].confirmed);
    assert.equal(confirmedAfterFinality, confirmedBeforeFinality - 100n);

    await service.applyActivity({
      ...finalized,
      state: 'observed',
      blockHash: '0xstale-block',
      observationSequence: '4',
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(BigInt(balances.balances[0].confirmed), confirmedAfterFinality);
    assert.equal(
      BigInt(balances.balances[0].provisional),
      beforeLargePostings - 1_000_000_000_000_000_000_000n - 1n,
    );

    await service.applyActivity({
      ...finalized,
      state: 'reverted',
      blockHash: undefined,
      changes: [],
      observationSequence: '6',
      canonicalReconciliation: true,
    });
    balances = await service.balances(walletIds[0], tenantId);
    assert.equal(BigInt(balances.balances[0].confirmed), confirmedBeforeFinality);
  },
);

test(
  'ledger accepts registered Litecoin wallet identifiers and posts its activity',
  { skip: !enabled },
  async () => {
    const walletId = randomUUID();
    const address = `ltc1${randomBytes(16).toString('hex')}`;
    const identifier = `transaction:litecoin:${randomUUID()}`;
    await service.registerWallet({
      walletId,
      tenantId,
      chain: 'litecoin',
      network: 'mainnet',
      address,
    });
    await service.applyActivity({
      identifier,
      chain: 'litecoin',
      network: 'mainnet',
      transactionHash: identifier.split(':').at(-1)!,
      sourceStatus: 'success',
      state: 'observed',
      completedAtTimestamp: 1000,
      observationSequence: '1',
      changes: [
        {
          wallet: `wallet:litecoin:${address}`,
          asset: 'token:litecoin:native',
          amount: '2500',
        },
      ],
    });

    const balances = await service.balances(walletId, tenantId);
    assert.equal(balances.chain, 'litecoin');
    assert.equal(balances.balances[0].provisional, '2500');
  },
);
