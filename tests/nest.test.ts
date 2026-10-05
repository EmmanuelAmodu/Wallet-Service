import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../apps/wallet/src/auth/auth.module.js';
import { WalletsModule } from '../apps/wallet/src/wallets/wallets.module.js';
import { TransactionsModule } from '../apps/wallet/src/transactions/transactions.module.js';
import { WalletsService } from '../apps/wallet/src/wallets/wallets.service.js';
import { TransactionsService } from '../apps/wallet/src/transactions/transactions.service.js';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { walletConfig, WalletSettings } from '../apps/wallet/src/config/wallet.config.js';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';
import { setupOpenApi } from '../apps/wallet/src/openapi.js';
import { LedgerClient } from '../apps/wallet/src/ledger/ledger-client.service.js';
import { LedgerController } from '../apps/ledger/src/ledger.controller.js';
import { LedgerService } from '../apps/ledger/src/ledger.service.js';
import { LedgerAuthGuard } from '../apps/ledger/src/ledger-auth.guard.js';
import { ledgerConfig } from '../apps/ledger/src/config/ledger.config.js';

const settings: WalletSettings = {
  apiKey: 'a'.repeat(64),
  databaseUrl: 'postgresql://unused:unused@localhost/unused',
  host: '127.0.0.1',
  port: 3000,
  seedId: 'test',
  ethereumChainId: '11155111',
  solanaGenesisHash: 'devnet',
  chainNetworks: {},
  ledgerUrl: 'http://127.0.0.1:3010',
  ledgerApiKey: 'c'.repeat(64),
};
@Global()
@Module({
  providers: [{ provide: walletConfig.KEY, useValue: settings }],
  exports: [walletConfig.KEY],
})
class TestSettingsModule {}

test('Ledger wallet HTTP routes authenticate reads and reject direct registration writes', async () => {
  const walletId = randomUUID();
  const apiKey = 'l'.repeat(64);
  const reads: string[] = [];
  let writes = 0;
  const module = await Test.createTestingModule({
    controllers: [LedgerController],
    providers: [
      LedgerAuthGuard,
      { provide: ledgerConfig.KEY, useValue: { apiKey } },
      {
        provide: LedgerService,
        useValue: {
          balances: (id: string) => {
            reads.push(id);
            return { walletId: id, balances: [] };
          },
          registerWallet: () => {
            writes++;
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  try {
    const denied = await fetch(`${base}/internal/wallets/${walletId}/balances`);
    assert.equal(denied.status, 401);
    assert.deepEqual(reads, []);
    const allowed = await fetch(`${base}/internal/wallets/${walletId}/balances`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { walletId, balances: [] });
    assert.deepEqual(reads, [walletId]);
    const directWrite = await fetch(`${base}/internal/wallets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ walletId }),
    });
    assert.equal(directWrite.status, 404);
    assert.equal(writes, 0);
  } finally {
    await app.close();
  }
});

test('Nest feature modules enforce single owner backend authentication, DTO pipes, UUIDs, idempotency headers and safe errors', async () => {
  const calls: unknown[][] = [];
  const balanceCalls: unknown[] = [];
  const balanceWalletId = randomUUID();
  const module = await Test.createTestingModule({
    imports: [TestSettingsModule, AuthModule, WalletsModule, TransactionsModule],
    providers: [{ provide: APP_FILTER, useClass: SafeErrorsFilter }],
  })
    .overrideProvider(WalletPrismaService)
    .useValue({})
    .overrideProvider(WalletsService)
    .useValue({
      createWallet: (...args: unknown[]) => {
        calls.push(args);
        return { status: 'deriving' };
      },
      getWallet: (id: string) => {
        if (id === balanceWalletId)
          return {
            id,
            chain: 'ethereum',
            network: '11155111',
            address: '0x' + '11'.repeat(20),
          };
        throw new Error('PRIVATE DATABASE CONNECTION DETAILS');
      },
    })
    .overrideProvider(LedgerClient)
    .useValue({
      balances: (request: unknown) => {
        balanceCalls.push(request);
        return { balances: [] };
      },
    })
    .overrideProvider(TransactionsService)
    .useValue({
      createTransaction: (...args: unknown[]) => {
        calls.push(args);
        return { status: 'preparing' };
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupOpenApi(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const authorization = `Bearer ${settings.apiKey}`;
  try {
    const documentation = await request('/docs-json');
    assert.equal(documentation.status, 200);
    const openApi = await documentation.json();
    assert.deepEqual(Object.keys(openApi.paths), []);
    assert.ok(openApi.components.securitySchemes.customerBearer);
    for (const value of ['', settings.apiKey, 'Bearer wrong']) {
      const response = await request(
        '/internal/wallets',
        { chain: 'ethereum', externalId: 'alice' },
        { authorization: value },
      );
      assert.equal(response.status, 401);
    }
    assert.equal(calls.length, 0);
    for (const body of [
      { chain: 'unsupported', externalId: 'alice' },
      { chain: 'ethereum', externalId: 'alice', tenant: 'tenantB' },
    ]) {
      const response = await request('/internal/wallets', body, { authorization });
      assert.equal(response.status, 400);
    }
    const created = await request(
      '/internal/wallets',
      { chain: 'ethereum', externalId: 'alice' },
      { authorization },
    );
    assert.equal(created.status, 202);
    assert.deepEqual(calls[0], ['ethereum', 'alice']);
    const balances = await request(`/internal/wallets/${balanceWalletId}/balances`, undefined, {
      authorization,
    });
    assert.equal(balances.status, 200);
    assert.deepEqual(balanceCalls[0], {
      walletId: balanceWalletId,
      chain: 'ethereum',
      network: '11155111',
      address: '0x' + '11'.repeat(20),
    });
    const invalidId = await request('/internal/wallets/not-a-uuid', undefined, { authorization });
    assert.equal(invalidId.status, 400);
    const failed = await request(`/internal/wallets/${randomUUID()}`, undefined, { authorization });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { message: 'Internal operation failed' });
    const walletId = randomUUID();
    const intent = {
      chain: 'ethereum',
      to: '0x' + '11'.repeat(20),
      amount: '1',
      maxFeePerGas: '2',
      maxPriorityFeePerGas: '1',
    };
    const missingKey = await request(`/internal/wallets/${walletId}/transactions`, intent, {
      authorization,
    });
    assert.equal(missingKey.status, 400);
    const transfer = await request(`/internal/wallets/${walletId}/transactions`, intent, {
      authorization: `Bearer ${settings.apiKey}`,
      'idempotency-key': 'payment-1',
    });
    assert.equal(transfer.status, 202);
    assert.deepEqual(calls[1], [walletId, 'payment-1', intent]);
  } finally {
    await app.close();
  }
});
