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

const settings: WalletSettings = {
  apiKeys: { tenantA: 'a'.repeat(64), tenantB: 'b'.repeat(64) },
  databaseUrl: 'postgresql://unused:unused@localhost/unused',
  host: '127.0.0.1',
  port: 3000,
  seedId: 'test',
  ethereumChainId: '11155111',
  solanaGenesisHash: 'devnet',
  chainNetworks: {},
};
@Global()
@Module({
  providers: [{ provide: walletConfig.KEY, useValue: settings }],
  exports: [walletConfig.KEY],
})
class TestSettingsModule {}

test('Nest feature modules enforce tenant guards, DTO pipes, UUIDs, idempotency headers and safe errors', async () => {
  const calls: unknown[][] = [];
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
      getWallet: () => {
        throw new Error('PRIVATE DATABASE CONNECTION DETAILS');
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
  const authorization = `Bearer ${settings.apiKeys.tenantA}`;
  try {
    const documentation = await request('/docs-json');
    assert.equal(documentation.status, 200);
    const openApi = await documentation.json();
    assert.deepEqual(Object.keys(openApi.paths).sort(), [
      '/v1/transactions/{id}',
      '/v1/transactions/{id}/broadcast',
      '/v1/transactions/{id}/refresh',
      '/v1/wallets',
      '/v1/wallets/{id}',
      '/v1/wallets/{id}/transactions',
    ]);
    assert.ok(openApi.components.securitySchemes.tenantBearer);
    for (const value of ['', settings.apiKeys.tenantA, 'Bearer wrong']) {
      const response = await request(
        '/v1/wallets',
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
      const response = await request('/v1/wallets', body, { authorization });
      assert.equal(response.status, 400);
    }
    const created = await request(
      '/v1/wallets',
      { chain: 'ethereum', externalId: 'alice' },
      { authorization },
    );
    assert.equal(created.status, 202);
    assert.deepEqual(calls[0], ['tenantA', 'ethereum', 'alice']);
    const invalidId = await request('/v1/wallets/not-a-uuid', undefined, { authorization });
    assert.equal(invalidId.status, 400);
    const failed = await request(`/v1/wallets/${randomUUID()}`, undefined, { authorization });
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
    const missingKey = await request(`/v1/wallets/${walletId}/transactions`, intent, {
      authorization,
    });
    assert.equal(missingKey.status, 400);
    const transfer = await request(`/v1/wallets/${walletId}/transactions`, intent, {
      authorization: `Bearer ${settings.apiKeys.tenantB}`,
      'idempotency-key': 'payment-1',
    });
    assert.equal(transfer.status, 202);
    assert.deepEqual(calls[1], ['tenantB', walletId, 'payment-1', intent]);
  } finally {
    await app.close();
  }
});
