import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { AccountsService, AccountSpec } from '../apps/ledger/src/accounts/accounts.service.js';
import { JournalService } from '../apps/ledger/src/journal/journal.service.js';
import { ReservationsService } from '../apps/ledger/src/reservations/reservations.service.js';
import { DepositsService } from '../apps/ledger/src/deposits/deposits.service.js';
import { ExchangeEvent, exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';

const enabled = Boolean(process.env.TEST_LEDGER_DATABASE_URL);
const db = enabled
  ? new LedgerPrismaService({ databaseUrl: process.env.TEST_LEDGER_DATABASE_URL! })
  : undefined;
const journal = new JournalService(new AccountsService());
const epoch = 'exchange-reservation-tests';
const service = enabled ? new ReservationsService(db!, journal, { resetEpoch: epoch }) : undefined;
const asset = { chain: 'ethereum' as const, network: '11155111', assetId: 'token:ethereum:native' };
before(async () => {
  if (db) await db.$connect();
});
after(async () => {
  if (db) await db.$disconnect();
});

async function fixture(balance = 100n) {
  const customerId = randomUUID(),
    domainId = `reservation-test-${randomUUID()}`,
    hotWalletId = randomUUID();
  await db!.exchangeCustomer.create({ data: { customer_id: customerId, domain_id: domainId } });
  await db!.exchangeWallet.create({
    data: {
      wallet_id: hotWalletId,
      domain_id: domainId,
      chain: asset.chain,
      network: asset.network,
      address: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`,
      address_key: hotWalletId,
      role: 'hot',
      account: 0,
      registry_revision: 1,
      reset_epoch: epoch,
    },
  });
  const account = (type: AccountSpec['type'], selectedAsset = asset): AccountSpec => ({
    domainId,
    ...selectedAsset,
    type,
    ownerKind: type === 'custody_hot' ? 'wallet' : 'customer',
    ownerId: type === 'custody_hot' ? hotWalletId : customerId,
    normalSide: type === 'custody_hot' || type === 'deficit' ? 'debit' : 'credit',
  });
  await db!.$transaction((tx) =>
    journal.post(tx, {
      key: randomUUID(),
      domainId,
      revision: 1,
      kind: 'test.customer-credit',
      postings: [
        { account: account('custody_hot'), side: 'debit', amount: balance },
        { account: account('customer_available'), side: 'credit', amount: balance },
      ],
    }),
  );
  const reserve = (amount: string, operationId: string = randomUUID()): ExchangeEvent =>
    exchangeEventSchema.parse({
      type: 'withdrawal.reserve.requested.v1',
      schemaVersion: 1,
      eventId: randomUUID(),
      resetEpoch: epoch,
      occurredAt: new Date().toISOString(),
      domainId,
      customerId,
      operationId,
      requestDigest: 'a'.repeat(64),
      policyVersion: 'exchange-financial-v1',
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: operationId,
      revision: 1,
      data: {
        principal: { asset, amount },
        hotWalletId,
        amounts: [{ asset, amount }],
        destination: '0x2222222222222222222222222222222222222222',
        quoteExpiresAt: new Date(Date.now() + 300000).toISOString(),
      },
    });
  const release = (request: ExchangeEvent, reservationId: string, revision = 2): ExchangeEvent =>
    exchangeEventSchema.parse({
      ...request,
      type: 'reservation.release.requested.v1',
      eventId: randomUUID(),
      revision,
      data: { reservationId, reason: 'Customer cancelled before signing' },
    });
  const available = (type: AccountSpec['type']) =>
    db!.$transaction((tx) => journal.balance(tx, account(type)));
  return { customerId, domainId, hotWalletId, account, reserve, release, available };
}

test(
  'simultaneous withdrawals cannot overspend and committed holds have durable result events',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const first = f.reserve('70'),
      second = f.reserve('70');
    await Promise.all([service!.handle(first), service!.handle(second)]);
    const reservations = await db!.withdrawalReservation.findMany({
      where: { domain_id: f.domainId },
    });
    assert.deepEqual(reservations.map((r) => r.state).sort(), ['held', 'rejected']);
    assert.equal(await f.available('customer_available'), 30n);
    assert.equal(await f.available('customer_reserved'), 70n);
    assert.equal(
      await db!.outbox.count({
        where: {
          dedupe_key: {
            in: reservations.map(
              (r) => `reservation:${r.id}:${r.state === 'held' ? 'reserved' : 'rejected'}`,
            ),
          },
        },
      }),
      2,
    );
  },
);

test(
  'business duplicate requests cannot reserve twice or alter accepted intent',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const request = f.reserve('60');
    await Promise.all([
      service!.handle(request),
      service!.handle(request),
      service!.handle({ ...request, eventId: randomUUID() }),
    ]);
    assert.equal(await f.available('customer_available'), 40n);
    const conflict = f.reserve('61', request.operationId!);
    await assert.rejects(service!.handle(conflict), /different request/);
    assert.equal(await db!.withdrawalReservation.count({ where: { domain_id: f.domainId } }), 1);
  },
);

test(
  'expired quotes and frozen customers reject holds without reducing available balances',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const original = f.reserve('70');
    const expired = exchangeEventSchema.parse({
      ...original,
      data: { ...original.data, quoteExpiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    await service!.handle(expired);
    assert.equal(
      (
        await db!.withdrawalReservation.findUniqueOrThrow({
          where: { operation_id: original.operationId },
        })
      ).state,
      'rejected',
    );
    await db!.exchangeCustomer.update({
      where: { customer_id: f.customerId },
      data: { state: 'frozen' },
    });
    await service!.handle(f.reserve('70'));
    assert.equal(await f.available('customer_available'), 100n);
    assert.equal(await f.available('customer_reserved'), 0n);
    await assert.rejects(
      service!.handle({ ...f.reserve('1'), resetEpoch: 'retired' }),
      /Stale reset epoch/,
    );
  },
);

test(
  'separate principal and fee assets are held atomically with no partial reservation',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const token = {
      ...asset,
      assetId: 'token:ethereum:erc20:0x1111111111111111111111111111111111111111',
    };
    await db!.$transaction((tx) =>
      journal.post(tx, {
        key: randomUUID(),
        domainId: f.domainId,
        revision: 1,
        kind: 'test.token-credit',
        postings: [
          { account: f.account('custody_hot', token), side: 'debit', amount: 40n },
          { account: f.account('customer_available', token), side: 'credit', amount: 40n },
        ],
      }),
    );
    const base = f.reserve('20');
    const request = exchangeEventSchema.parse({
      ...base,
      data: {
        ...base.data,
        principal: { asset: token, amount: '20' },
        customerFee: { asset, amount: '5' },
        amounts: [
          { asset: token, amount: '20' },
          { asset, amount: '5' },
        ],
      },
    });
    await service!.handle(request);
    assert.equal(await f.available('customer_available'), 95n);
    assert.equal(
      await db!.$transaction((tx) => journal.balance(tx, f.account('customer_reserved', token))),
      20n,
    );
    const invalid = exchangeEventSchema.parse({
      ...request,
      eventId: randomUUID(),
      operationId: randomUUID(),
      data: {
        ...request.data,
        customerFee: { asset, amount: '96' },
        amounts: [
          { asset: token, amount: '20' },
          { asset, amount: '96' },
        ],
      },
    });
    await service!.handle(invalid);
    assert.equal(await f.available('customer_available'), 95n);
    assert.equal(
      await db!.$transaction((tx) => journal.balance(tx, f.account('customer_reserved', token))),
      20n,
    );
  },
);

test(
  'release is idempotent before signing and refuses signed or uncertain obligations',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const request = f.reserve('60');
    await service!.handle(request);
    const hold = await db!.withdrawalReservation.findUniqueOrThrow({
      where: { operation_id: request.operationId },
    });
    await Promise.all([
      service!.handle(f.release(request, hold.id)),
      service!.handle(f.release(request, hold.id)),
    ]);
    assert.equal(await f.available('customer_available'), 100n);
    assert.equal(await f.available('customer_reserved'), 0n);
    const signed = f.reserve('70');
    await service!.handle(signed);
    const signedHold = await db!.withdrawalReservation.findUniqueOrThrow({
      where: { operation_id: signed.operationId },
    });
    await db!.exchangeOperation.create({
      data: {
        id: signed.operationId!,
        domain_id: f.domainId,
        customer_id: f.customerId,
        reservation_id: signedHold.id,
        request_digest: signed.requestDigest!,
        kind: 'withdrawal',
        payload: {},
        state: 'signed',
        reset_epoch: epoch,
      },
    });
    await service!.handle(f.release(signed, signedHold.id));
    assert.equal(await f.available('customer_available'), 30n);
    assert.equal(await f.available('customer_reserved'), 70n);
    assert.equal((await service!.get(f.domainId, signedHold.id))!.state, 'held');
  },
);

test(
  'reconciliation resends committed results and queries operations without releasing holds',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const request = f.reserve('60');
    await service!.handle(request);
    const hold = await db!.withdrawalReservation.findUniqueOrThrow({
      where: { operation_id: request.operationId },
    });
    await db!.outbox.updateMany({
      where: { dedupe_key: `reservation:${hold.id}:reserved` },
      data: { published_at: new Date() },
    });
    assert.equal(await service!.reconcile(f.domainId), 1);
    const replay = await db!.outbox.findMany({
      where: { dedupe_key: { startsWith: `reservation:${hold.id}:` }, published_at: null },
    });
    assert.deepEqual(replay.map((r) => (r.payload as unknown as ExchangeEvent).type).sort(), [
      'operation.reconcile.requested.v1',
      'withdrawal.reserved.v1',
    ]);
    assert.equal(await f.available('customer_reserved'), 60n);
    assert.equal((await service!.get(f.domainId, hold.id))!.state, 'held');
    const missing = exchangeEventSchema.parse({
      ...request,
      eventId: randomUUID(),
      type: 'operation.reconcile.responded.v1',
      data: { found: false },
    });
    await service!.recordReconciliation(missing);
    await service!.recordReconciliation(missing);
    assert.equal(await f.available('customer_reserved'), 60n);
    assert.equal((await service!.get(f.domainId, hold.id))!.state, 'held');
    assert.equal(
      await db!.ledgerIncident.count({ where: { operation_id: request.operationId } }),
      1,
    );
  },
);

test(
  'safe cancellation offsets deposit-reorg deficit without reviving invalid customer credit',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const walletId = randomUUID(),
      depositId = randomUUID(),
      transactionHash = randomUUID();
    await db!.exchangeWallet.create({
      data: {
        wallet_id: walletId,
        domain_id: f.domainId,
        customer_id: f.customerId,
        chain: asset.chain,
        network: asset.network,
        address: walletId,
        address_key: walletId,
        role: 'customer',
        account: 10,
        hot_wallet_id: f.hotWalletId,
        registry_revision: 1,
        reset_epoch: epoch,
      },
    });
    const deposit = (type: string, revision: number) =>
      exchangeEventSchema.parse({
        type,
        schemaVersion: 1,
        eventId: randomUUID(),
        resetEpoch: epoch,
        occurredAt: new Date().toISOString(),
        domainId: f.domainId,
        customerId: f.customerId,
        correlationId: randomUUID(),
        causationId: null,
        aggregateId: depositId,
        revision,
        data: {
          depositId,
          asset,
          transactionHash,
          transferIdentity: { kind: 'evm.native', id: 'top-level' },
          ...(type === 'deposit.finalized.v1'
            ? { walletId, amount: '100', blockHash: 'block' }
            : { reason: 'Reorg' }),
        },
      });
    const final = deposit('deposit.finalized.v1', 1);
    const deposits = new DepositsService(db!, journal, { resetEpoch: epoch });
    await deposits.handle(final);
    const request = f.reserve('180');
    await service!.handle(request);
    const hold = await db!.withdrawalReservation.findUniqueOrThrow({
      where: { operation_id: request.operationId },
    });
    await deposits.handle(deposit('deposit.reverted.v1', 2));
    assert.equal(await f.available('deficit'), 80n);
    await service!.handle(f.release(request, hold.id));
    assert.equal(await f.available('deficit'), 0n);
    assert.equal(await f.available('customer_reserved'), 0n);
    assert.equal(await f.available('customer_available'), 0n);
    assert.equal(await f.available('customer_frozen'), 100n);
  },
);
