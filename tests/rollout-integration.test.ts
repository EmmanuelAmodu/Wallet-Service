import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { custodySettings, isolatedDatabase } from './helpers/custody-fixture.js';
import { acceptanceRollout } from './helpers/rollout-fixture.js';

test(
  'Phase 8 canary issuance rejects other chains atomically and preserves an existing deposit address when issuance is paused',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const fixture = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    const db = new WalletPrismaService({ databaseUrl: fixture.url }),
      domainId = `canary-${randomUUID()}`,
      epoch = randomUUID(),
      customerId = randomUUID();
    const policy = {
      ...acceptanceRollout,
      mode: 'canary' as const,
      canary: { domainId, chain: 'ethereum', network: '11155111' },
    };
    const custody = new CustodyService(
      db,
      custodySettings(domainId),
      { domainId, apiKey: undefined },
      { resetEpoch: epoch },
      policy,
    );
    try {
      await custody.bootstrap();
      await db.exchangeCustomer.create({
        data: {
          customer_id: customerId,
          external_id: customerId,
          domain_id: domainId,
          reset_epoch: epoch,
        },
      });
      const counts = async () => Promise.all([db.wallet.count(), db.outbox.count()]);
      const before = await counts();
      await assert.rejects(
        () =>
          db.$transaction((tx) => custody.allocateCustomer(tx, customerId, 'bitcoin', 'regtest')),
        /addresses paused/,
      );
      assert.deepEqual(await counts(), before);
      const first = await db.$transaction((tx) =>
        custody.allocateCustomer(tx, customerId, 'ethereum', '11155111'),
      );
      assert.equal(first.account, 10);
      assert.equal(first.custody_role, 'customer_deposit');
      policy.addresses = false;
      const again = await db.$transaction((tx) =>
        custody.allocateCustomer(tx, customerId, 'ethereum', '11155111'),
      );
      assert.equal(again.id, first.id);
      assert.equal(again.path, first.path);
      const next = randomUUID();
      await db.exchangeCustomer.create({
        data: { customer_id: next, external_id: next, domain_id: domainId, reset_epoch: epoch },
      });
      await assert.rejects(
        () => db.$transaction((tx) => custody.allocateCustomer(tx, next, 'ethereum', '11155111')),
        /addresses paused/,
      );
    } finally {
      await db.$disconnect();
      await fixture.drop();
    }
  },
);
