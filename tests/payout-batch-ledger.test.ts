import 'reflect-metadata';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { SettlementsService } from '../apps/ledger/src/settlements/settlements.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { isolatedDatabase, testMnemonic } from './helpers/custody-fixture.js';
import {
  payoutBatchManifestSchema,
  payoutBatchDigest,
  mapBatchOutputs,
  allocateBatchCosts,
} from '../packages/shared/src/payout-policy.js';
import {
  validateBitcoinBatch,
  PayoutBatchLedgerCommand,
} from '../packages/shared/src/bitcoin-batch-contracts.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { regtestWitnessAddress } from '../packages/chain/src/bitcoin-address.js';
import { MessageAuth, messageSchema } from '../packages/queue/src/messages.js';

const source = process.env.TEST_LEDGER_DATABASE_URL;
let core: SigningCore;
before(async () => {
  core = await SigningCore.create(testMnemonic, 'batch-ledger', '11155111', undefined, {
    domainId: 'batch',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  });
});
after(() => core.close());

async function fixture() {
  const isolated = await isolatedDatabase(source!, 'ledger'),
    db = new LedgerPrismaService({ databaseUrl: isolated.url });
  try {
    const domainId = 'batch-' + randomUUID(),
      resetEpoch = randomUUID(),
      hotId = randomUUID();
    const hot = core.derive({ seedId: 'batch-ledger', chain: 'bitcoin', account: 0 }),
      recipient = core.derive({ seedId: 'batch-ledger', chain: 'bitcoin', account: 10 });
    const asset = {
      chain: 'bitcoin' as const,
      network: 'regtest',
      assetId: 'token:bitcoin:native' as const,
    };
    await db.exchangeWallet.create({
      data: {
        wallet_id: hotId,
        domain_id: domainId,
        reset_epoch: resetEpoch,
        chain: asset.chain,
        network: asset.network,
        address: hot.address,
        address_key: hot.address,
        role: 'hot',
        account: 0,
        registry_revision: 1,
      },
    });
    const journal = new JournalService(new AccountsService()),
      reservations = new ReservationsService(db, journal, { resetEpoch }),
      settlements = new SettlementsService(db, journal, reservations);
    const spec = (type: AccountSpec['type'], ownerId: string): AccountSpec => ({
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
    const members = [];
    for (let i = 0; i < 3; i++) {
      const customerId = randomUUID(),
        operationId = randomUUID(),
        requestDigest = executionDigest(operationId);
      await db.exchangeCustomer.create({ data: { customer_id: customerId, domain_id: domainId } });
      await db.$transaction((tx) =>
        journal.post(tx, {
          key: randomUUID(),
          domainId,
          revision: 1,
          kind: 'fixture.credit',
          postings: [
            { account: spec('custody_hot', hotId), side: 'debit', amount: 100000n },
            { account: spec('customer_available', customerId), side: 'credit', amount: 100000n },
          ],
        }),
      );
      const request = exchangeEventSchema.parse({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        domainId,
        resetEpoch,
        correlationId: operationId,
        causationId: null,
        aggregateId: operationId,
        revision: 1,
        customerId,
        operationId,
        requestDigest,
        policyVersion: 'exchange-financial-v1',
        type: 'withdrawal.reserve.requested.v1',
        data: {
          hotWalletId: hotId,
          destination: recipient.address,
          principal: { asset, amount: '1000' },
          amounts: [{ asset, amount: '1000' }],
          quoteExpiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      });
      await reservations.handle(request);
      const hold = await db.withdrawalReservation.findUniqueOrThrow({
        where: { operation_id: operationId },
      });
      assert.equal(hold.state, 'held');
      members.push({
        operationId,
        attemptId: randomUUID(),
        reservationId: hold.id,
        customerId,
        requestDigest,
        destination: recipient.address,
        principalUnits: '1000',
        maximumFeeUnits: '1000',
        maximumRentUnits: '0',
      });
    }
    members.sort((a, b) => a.operationId.localeCompare(b.operationId));
    const manifest = payoutBatchManifestSchema.parse({
      version: 1,
      batchId: randomUUID(),
      domainId,
      resetEpoch,
      seedId: 'batch-ledger',
      sourceWalletId: hotId,
      sourceRegistryRevision: 1,
      sourceAddress: hot.address,
      asset,
      members,
      feeAllocation: 'equal-largest-remainder-v1',
    });
    const request = {
      wallet: {
        seedId: 'batch-ledger',
        chain: 'bitcoin',
        network: 'regtest',
        account: 0,
        address: hot.address,
      },
      transaction: {
        chain: 'bitcoin',
        outputs: members.map((m) => ({ address: m.destination, amount: m.principalUnits })),
        utxos: [
          {
            txid: 'a'.repeat(64),
            vout: 0,
            amount: '100000',
            script:
              '0014' + Buffer.from(regtestWitnessAddress(hot.address).program).toString('hex'),
          },
        ],
        satsPerVbyte: 2,
        changeAmount: '96500',
      },
    };
    const body = {
      version: 1,
      batchId: manifest.batchId,
      manifestDigest: payoutBatchDigest(manifest),
      request,
      requestDigest: executionDigest(request),
      principalUnits: '3000',
      feeUnits: '500',
      changeUnits: '96500',
      changeOutputIndex: 1,
      memberOutputs: mapBatchOutputs(manifest, '96500'),
      memberCosts: allocateBatchCosts(manifest, '500'),
      resourceKeys: ['utxo:' + 'a'.repeat(64) + ':0'],
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    const preparation = validateBitcoinBatch(manifest, {
      ...body,
      preparationDigest: executionDigest(body),
    }).preparation;
    const prepare: PayoutBatchLedgerCommand = {
      type: 'payout.batch.ledger.prepare',
      domainId,
      resetEpoch,
      batchId: manifest.batchId,
      manifest,
      preparation,
    };
    const settle: PayoutBatchLedgerCommand = {
      type: 'payout.batch.ledger.settle',
      domainId,
      resetEpoch,
      batchId: manifest.batchId,
      revision: 1,
      transactionHash: 'b'.repeat(64),
      actualFeeUnits: '500',
      blockHash: 'c'.repeat(64),
      blockHeight: '101',
    };
    return {
      db,
      settlements,
      reservations,
      manifest,
      prepare,
      settle,
      spec,
      journal,
      hotId,
      balance: (type: AccountSpec['type'], ownerId: string) =>
        db.$transaction((tx) => journal.balance(tx, spec(type, ownerId))),
      close: async () => {
        await db.$disconnect();
        await isolated.drop();
      },
    };
  } catch (error) {
    await db.$disconnect();
    await isolated.drop();
    throw error;
  }
}

test(
  'batch approval and settlement preserve separate original holds and conserve one transaction fee under replay/reorg/reinclusion',
  { skip: !source },
  async () => {
    const f = await fixture();
    try {
      await f.settlements.handleBatch(f.prepare);
      await f.settlements.handleBatch(f.prepare);
      assert.equal(await f.db.ledgerPayoutBatchMember.count(), 3);
      await f.settlements.handleBatch(f.settle);
      const journals = await f.db.journalBatch.count();
      await f.settlements.handleBatch(f.settle);
      assert.equal(await f.db.journalBatch.count(), journals);
      await assert.rejects(
        f.settlements.handleBatch({ ...f.settle, revision: 2 } as PayoutBatchLedgerCommand),
        /canonical reversal first/,
      );
      await assert.rejects(
        f.settlements.handleBatch({
          type: 'payout.batch.ledger.revert',
          domainId: f.manifest.domainId,
          resetEpoch: f.manifest.resetEpoch,
          batchId: f.manifest.batchId,
          revision: 3,
          priorSettlementRevision: 2,
          reason: 'Wrong referenced revision',
        }),
        /current canonical settlement/,
      );
      assert.equal(await f.balance('custody_hot', f.hotId), 296500n);
      for (const m of f.manifest.members)
        assert.equal(await f.balance('customer_reserved', m.customerId), 0n);
      const reverted: PayoutBatchLedgerCommand = {
        type: 'payout.batch.ledger.revert',
        domainId: f.manifest.domainId,
        resetEpoch: f.manifest.resetEpoch,
        batchId: f.manifest.batchId,
        revision: 2,
        priorSettlementRevision: 1,
        reason: 'Canonical block disappeared',
      };
      await f.settlements.handleBatch(reverted);
      await f.settlements.handleBatch(reverted);
      assert.equal(await f.balance('custody_hot', f.hotId), 300000n);
      for (const m of f.manifest.members) {
        assert.equal(await f.balance('customer_reserved', m.customerId), 1000n);
        const hold = await f.db.withdrawalReservation.findUniqueOrThrow({
          where: { id: m.reservationId },
        });

        test(
          'a failure while settling a later batch member rolls back earlier journals, original holds and canonical batch state',
          { skip: !source },
          async () => {
            const f = await fixture();
            try {
              await f.settlements.handleBatch(f.prepare);
              const before = await f.db.journalBatch.count();
              const failureOperation = f.manifest.members[1].operationId;
              const journal = new (class extends JournalService {
                override async post(
                  tx: Parameters<JournalService['post']>[0],
                  request: Parameters<JournalService['post']>[1],
                ) {
                  if (request.kind === 'settlement' && request.operationId === failureOperation)
                    throw new Error('Simulated crash after earlier member journal');
                  return super.post(tx, request);
                }
              })(new AccountsService());
              await assert.rejects(
                new SettlementsService(f.db, journal, f.reservations).handleBatch(f.settle),
                /Simulated crash/,
              );
              assert.equal(await f.db.journalBatch.count(), before);
              assert.equal(await f.db.ledgerPayoutBatchReceipt.count(), 0);
              assert.equal(
                (
                  await f.db.ledgerPayoutBatch.findUniqueOrThrow({
                    where: { id: f.manifest.batchId },
                  })
                ).revision,
                0,
              );
              for (const member of f.manifest.members) {
                assert.equal(
                  (
                    await f.db.withdrawalReservation.findUniqueOrThrow({
                      where: { id: member.reservationId },
                    })
                  ).state,
                  'held',
                );
                assert.equal(await f.balance('customer_reserved', member.customerId), 1000n);
              }
              await f.settlements.handleBatch(f.settle);
              assert.equal(await f.balance('custody_hot', f.hotId), 296500n);
            } finally {
              await f.close();
            }
          },
        );
        assert(['held', 'frozen'].includes(hold.state));
      }
      await f.settlements.handleBatch({
        ...f.settle,
        revision: 3,
        blockHash: 'd'.repeat(64),
      } as PayoutBatchLedgerCommand);
      assert.equal(await f.balance('custody_hot', f.hotId), 296500n);
      const before = await f.db.journalBatch.count();
      await assert.rejects(
        f.settlements.handleBatch({
          ...f.settle,
          actualFeeUnits: '501',
        } as PayoutBatchLedgerCommand),
        /conflicting content/,
      );
      await assert.rejects(
        f.settlements.handleBatch({
          ...f.settle,
          revision: 4,
          transactionHash: 'e'.repeat(64),
        } as PayoutBatchLedgerCommand),
        /identity is immutable/,
      );
      assert.equal(await f.db.journalBatch.count(), before);
      assert.equal(await f.db.ledgerPayoutBatchReceipt.count(), 3);
      const auth = new MessageAuth('x'.repeat(64), f.manifest.resetEpoch);
      for (const outbox of await f.db.outbox.findMany({
        where: { payload: { path: ['type'], equals: 'payout.batch.ledger.result' } },
      }))
        auth.seal(messageSchema.parse(outbox.payload), outbox.id);
    } finally {
      await f.close();
    }
  },
);

test(
  'invalid later member rolls back all batch approvals; individual financial processing cannot partially settle or release approved members',
  { skip: !source },
  async () => {
    const f = await fixture();
    try {
      await f.db.exchangeCustomer.update({
        where: { customer_id: f.manifest.members[2].customerId },
        data: { state: 'frozen' },
      });
      await assert.rejects(f.settlements.handleBatch(f.prepare), /Frozen customer/);
      assert.equal(await f.db.ledgerPayoutBatch.count(), 0);
      assert.equal(await f.db.exchangeOperation.count(), 0);
      await f.db.exchangeCustomer.update({
        where: { customer_id: f.manifest.members[2].customerId },
        data: { state: 'active' },
      });
      await f.settlements.handleBatch(f.prepare);
      const member = f.manifest.members[0];
      const operation = await f.db.exchangeOperation.findUniqueOrThrow({
        where: { id: member.operationId },
      });
      const original = exchangeEventSchema.parse(operation.payload);
      await assert.rejects(
        f.settlements.handle(
          exchangeEventSchema.parse({
            ...original,
            eventId: randomUUID(),
            type: 'settlement.requested.v1',
            data: { transactionHash: 'b'.repeat(64), actualFees: [], outcome: 'confirmed' },
          }),
        ),
        /atomic complete batch/,
      );
      await assert.rejects(
        f.db.withdrawalReservation.update({
          where: { id: member.reservationId },
          data: { state: 'released' },
        }),
        /atomic batch financial processing/,
      );
      await assert.rejects(
        f.db.ledgerPayoutBatchMember.delete({
          where: { batch_id_member_index: { batch_id: f.manifest.batchId, member_index: 0 } },
        }),
        /retained/,
      );
      assert.equal(await f.balance('customer_reserved', member.customerId), 1000n);
    } finally {
      await f.close();
    }
  },
);
