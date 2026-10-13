import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { SafeErrorsFilter } from '../packages/shared/src/http/safe-errors.filter.js';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { CustodySnapshotReader } from '../packages/chain/src/custody-snapshot.js';
import { reconcileAccounting } from '../apps/ledger/src/operations/reconciliation.service.js';
import {
  OperationsController,
  OperationsGuard,
} from '../apps/wallet/src/operations/operations.controller.js';
import {
  OperationsService,
  operationsCommandSchema,
} from '../apps/wallet/src/operations/operations.service.js';
import { operationsConfig } from '../apps/wallet/src/config/operations.config.js';
import { walletConfig } from '../apps/wallet/src/config/wallet.config.js';
import { WalletAuthGuard } from '../apps/wallet/src/auth/wallet-auth.guard.js';
import { exchangeEventSchema } from '../packages/queue/src/exchange-contracts.js';
import { MessageAuth } from '../packages/queue/src/messages.js';
import { devnet } from './helpers/custody-fixture.js';

class Rpc extends ChainRpcService {
  constructor(private readonly handler: (method: string, params: unknown[]) => unknown) {
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
  ) {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'getGenesisHash') return devnet;
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    return this.handler(method, params);
  }
}
const ethereum = { chain: 'ethereum', network: '11155111', address: '0x' + '11'.repeat(20) },
  hash = '0x' + 'ab'.repeat(32);

function eth(fork = false) {
  let calls = 0;
  return new Rpc((method) => {
    if (method === 'eth_getBlockByNumber')
      return { hash: fork && ++calls > 1 ? '0x' + 'cd'.repeat(32) : hash, number: '0x64' };
    if (method === 'eth_getBalance') return '0x20000000000001';
    if (method === 'eth_getTransactionCount') return '0x2';
    throw new Error('Unknown RPC');
  });
}

test('Operations custody reads preserve exact native units and require canonical block identity', async () => {
  const [observed] = await new CustodySnapshotReader(eth()).read(ethereum, []);
  assert.equal(observed.units, '9007199254740993');
  assert.equal(observed.nonce, '2');
  assert.equal(observed.blockHash, hash);
  assert.equal(observed.state, 'observed');
  const [fork] = await new CustodySnapshotReader(eth(true)).read(ethereum, []);
  assert.equal(fork.state, 'unavailable');
  assert.equal(fork.units, undefined);
});
test('RPC absence, malformed responses and wrong networks never become zero custody', async () => {
  for (const rpc of [
    new Rpc(() => {
      throw new Error('Unavailable');
    }),
    new Rpc(() => ({ garbage: true })),
  ]) {
    const [result] = await new CustodySnapshotReader(rpc).read(ethereum, []);
    assert.equal(result.state, 'unavailable');
    assert.equal(result.units, undefined);
  }
  const [wrong] = await new CustodySnapshotReader(eth()).read({ ...ethereum, network: '1' }, []);
  assert.equal(wrong.state, 'unavailable');
});
test('Bitcoin canonical UTXO scan preserves satoshis and detects a scan fork', async () => {
  const rpc = new Rpc((method) =>
    method === 'scantxoutset'
      ? {
          success: true,
          height: 100,
          bestblock: 'ab'.repeat(32),
          unspents: [
            { txid: '11'.repeat(32), vout: 0, amount: '0.12345678' },
            { txid: '22'.repeat(32), vout: 1, amount: 0.00000001 },
          ],
        }
      : 'ab'.repeat(32),
  );
  const wallet = { chain: 'bitcoin', network: 'regtest', address: 'bcrt1qfixture' };
  const [observed] = await new CustodySnapshotReader(rpc).read(wallet, []);
  assert.equal(observed.units, '12345679');
  const broken = new Rpc((method) =>
    method === 'scantxoutset'
      ? { success: true, height: 100, bestblock: 'ab'.repeat(32), unspents: [] }
      : 'cd'.repeat(32),
  );
  assert.equal((await new CustodySnapshotReader(broken).read(wallet, []))[0].state, 'unavailable');
});
test('Solana mixed account contexts remain unavailable rather than claim a coherent balance', async () => {
  const rpc = new Rpc((method) => {
    if (method === 'getSlot') return 100;
    if (method === 'getAccountInfo')
      return {
        context: { slot: 100 },
        value: {
          owner: '11111111111111111111111111111111',
          executable: false,
          lamports: 10000000,
          data: ['', 'base64'],
        },
      };
    if (method === 'getTokenAccountsByOwner') return { context: { slot: 101 }, value: [] };
    throw new Error('Unexpected RPC');
  });
  assert.equal(
    (
      await new CustodySnapshotReader(rpc).read(
        { chain: 'solana', network: devnet, address: '3'.repeat(32) },
        [],
      )
    )[0].state,
    'unavailable',
  );
});
test('Accounting reconciliation explains custody, rent, liabilities, equity, fees, deficits and in-transit by asset', () => {
  const make = (type: string, balance: string, normal_side = 'debit') => ({
    type,
    balance,
    normal_side,
    owner_id: 'fixture',
    chain: 'ethereum',
    network: '11155111',
    asset_id: 'token:ethereum:native',
    sequence: '1',
  });
  const [report] = reconcileAccounting([
    make('custody_hot', '80'),
    make('custody_rent', '5'),
    make('custody_in_transit', '10'),
    make('fee_expense', '3'),
    make('deficit', '2'),
    make('customer_available', '60', 'credit'),
    make('customer_reserved', '10', 'credit'),
    make('equity', '28', 'credit'),
    make('fee_revenue', '2', 'credit'),
  ]);
  assert.equal(report.bookEquation, '0');
  assert.equal(report.physicalCustody, '85');
  assert.equal(report.liabilities, '70');
  assert.equal(report.accounts.custody_in_transit, '10');
  const [bad] = reconcileAccounting([make('custody_hot', '1')]);
  assert.equal(bad.bookEquation, '1');
});
test('Operational DTOs prohibit hold release, replacements, arbitrary targets and caller-supplied identity', () => {
  for (const body of [
    { action: 'release-hold' },
    { action: 'replace-transaction' },
    { action: 'pause-domain', actor: 'untrusted' },
    { action: 'retry-execution', transactionId: randomUUID(), amount: '100' },
  ])
    assert.equal(
      operationsCommandSchema.safeParse({ commandId: randomUUID(), reason: 'Review', ...body })
        .success,
      false,
    );
});
test('Operational queue evidence is authenticated and reset-scoped like financial traffic', () => {
  const auth = new MessageAuth('q'.repeat(64), 'current'),
    event = exchangeEventSchema.parse({
      type: 'operations.repair.requested.v1',
      schemaVersion: 1,
      eventId: randomUUID(),
      resetEpoch: 'current',
      domainId: 'exchange',
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: 'operations',
      revision: 1,
      data: { commandId: randomUUID() },
    }),
    id = randomUUID(),
    sealed = auth.seal(event, id);
  assert.deepEqual(auth.open(sealed, id, event.type), event);
  assert.throws(() =>
    auth.open({ ...sealed, payload: { ...event, domainId: 'other' } }, id, event.type),
  );
  assert.throws(() => new MessageAuth('q'.repeat(64), 'next').open(sealed, id, event.type));
});

const serviceKey = 'w'.repeat(64),
  operationsKey = 'o'.repeat(64);
@Module({
  controllers: [OperationsController],
  providers: [
    { provide: APP_FILTER, useClass: SafeErrorsFilter },
    OperationsGuard,
    { provide: operationsConfig.KEY, useValue: { apiKey: operationsKey } },
    { provide: walletConfig.KEY, useValue: { apiKey: serviceKey } },
    { provide: APP_GUARD, useClass: WalletAuthGuard },
    {
      provide: OperationsService,
      useValue: {
        status: async () => ({ state: 'fixture' }),
        command: async (body: unknown) => body,
        metrics: async () => [],
      },
    },
  ],
})
class HttpModule {}
test('Operations HTTP requires both private credentials; customer tokens and malformed commands cannot execute', async () => {
  const module = await Test.createTestingModule({ imports: [HttpModule] }).compile(),
    app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/internal/operations`;
  try {
    for (const headers of [
      { authorization: 'Bearer customer.jwt.token', 'x-operations-key': operationsKey },
      { authorization: `Bearer ${serviceKey}` },
      { authorization: `Bearer ${serviceKey}`, 'x-operations-key': 'bad' },
    ])
      assert.equal((await fetch(url, { headers: headers as Record<string, string> })).status, 401);
    const headers = {
      authorization: `Bearer ${serviceKey}`,
      'x-operations-key': operationsKey,
      'content-type': 'application/json',
    };
    assert.equal((await fetch(url, { headers: headers as Record<string, string> })).status, 200);
    assert.equal(
      (
        await fetch(`${url}/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandId: randomUUID(),
            action: 'release-hold',
            reason: 'Unsafe',
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${url}/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandId: randomUUID(),
            action: 'repair',
            reason: 'Recover retained messages',
          }),
        })
      ).status,
      201,
    );
  } finally {
    await app.close();
  }
});

test('Failed consumer repair retries only original authenticated current-scope jobs', async () => {
  const { retryFailedConsumerJobs } = await import('../packages/queue/src/consumer-repair.js');
  const auth = new MessageAuth('q'.repeat(64), 'current');
  let retried = 0;
  const make = (domainId: string, epoch: string) => {
    const id = randomUUID(),
      event = exchangeEventSchema.parse({
        type: 'operations.repair.requested.v1',
        schemaVersion: 1,
        eventId: randomUUID(),
        resetEpoch: epoch,
        domainId,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        causationId: null,
        aggregateId: 'operations',
        revision: 1,
        data: { commandId: randomUUID() },
      }),
      data = new MessageAuth('q'.repeat(64), epoch).seal(event, id);
    return {
      id,
      name: event.type,
      data,
      getState: async () => 'failed',
      retry: async () => {
        assert.equal(data.payload, event);
        retried++;
      },
    };
  };
  const queue = {
    getFailed: async () => [
      make('exchange', 'current'),
      make('other', 'current'),
      make('exchange', 'old'),
    ],
  };
  const result = await retryFailedConsumerJobs(
    queue as unknown as import('bullmq').Queue,
    auth,
    'exchange',
  );
  assert.equal(retried, 1);
  assert.deepEqual(result, { retried: 1, stale: 2 });
});
