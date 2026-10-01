import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WalletWorkflowService } from '../apps/wallet/src/messaging/wallet-workflow.service';
import { TransactionsService } from '../apps/wallet/src/transactions/transactions.service';
import { WalletProcessor } from '../apps/wallet/src/messaging/wallet.processor';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service';
import { Job } from 'bullmq';
import { WalletPrismaService, createDatabase } from '../apps/wallet/src/prisma/prisma.service';
import { migrate } from '../scripts/migrate';
import { WalletsService } from '../apps/wallet/src/wallets/wallets.service';
import { Transfer } from '../packages/shared/src/contracts';
import { Message, MessageAuth, QUEUES } from '../packages/queue/src/messages';

const enabled = !!process.env.TEST_DATABASE_URL;
const db = enabled ? createDatabase(process.env.TEST_DATABASE_URL!) : undefined;
let service: WalletsService;
let transactions: TransactionsService;
const tenant = randomUUID();
const inboxIds: string[] = [];
const intent: Transfer = {
  chain: 'ethereum',
  to: '0x' + '11'.repeat(20),
  amount: '1',
  maxFeePerGas: '2',
  maxPriorityFeePerGas: '1',
};
before(async () => {
  if (db) {
    await migrate(process.env.TEST_DATABASE_URL!);
    transactions = new TransactionsService(db, {
      seedId: 'test',
      ethereumChainId: '11155111',
      solanaGenesisHash: 'devnet',
    });
    service = new WalletsService(db, {
      seedId: 'test',
      ethereumChainId: '11155111',
      solanaGenesisHash: 'devnet',
    });
  }
});
after(async () => {
  if (db) {
    const wallets = await db.wallet.findMany({ where: { tenant_id: tenant } }),
      txs = await db.transaction.findMany({ where: { tenant_id: tenant } });
    const ids = [...wallets, ...txs].map((x) => x.id);
    await db.outbox.deleteMany({
      where: { OR: ids.map((id) => ({ dedupe_key: { contains: id } })) },
    });
    await db.inbox.deleteMany({ where: { id: { in: inboxIds } } });
    await db.transaction.deleteMany({ where: { tenant_id: tenant } });
    await db.wallet.deleteMany({ where: { tenant_id: tenant } });
    await db.$disconnect();
  }
});
test(
  'Prisma: concurrent creation, tenant isolation, idempotency and atomic outbox without Redis',
  { skip: !enabled },
  async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () => service.createWallet(tenant, 'ethereum', 'alice')),
    );
    assert(wallets.every((w) => w.id === wallets[0].id));
    const wallet = wallets[0];
    assert.equal(wallet.status, 'deriving');
    assert.equal(wallet.address, null);
    const action = await db!.outbox.findUniqueOrThrow({
      where: { dedupe_key: `derive-${wallet.id}` },
    });
    assert.equal(action.queue, QUEUES.signer);
    assert.equal(action.published_at, null);
    await assert.rejects(() => service.getWallet('different-tenant', wallet.id), /not found/);
    await assert.rejects(
      () => transactions.createTransaction(tenant, wallet.id, 'payment-1', intent),
      /not ready/,
    );
    await db!.wallet.update({
      where: { id: wallet.id },
      data: { status: 'ready', address: '0x' + wallet.account.toString(16).padStart(40, '0') },
    });
    const txs = await Promise.all(
      Array.from({ length: 5 }, () =>
        transactions.createTransaction(tenant, wallet.id, 'payment-1', intent),
      ),
    );
    assert(txs.every((t) => t.id === txs[0].id));
    const tx = txs[0];
    assert.equal(tx.status, 'preparing');
    assert.equal(tx.signed, null);
    assert.equal(await db!.outbox.count({ where: { dedupe_key: `prepare-${tx.id}` } }), 1);
    await assert.rejects(() => transactions.getTransaction('different-tenant', tx.id), /not found/);
    await assert.rejects(
      () =>
        transactions.createTransaction(tenant, wallet.id, 'payment-1', { ...intent, amount: '2' }),
      /different request/,
    );
    await assert.rejects(
      () => transactions.createTransaction(tenant, wallet.id, 'payment-2', intent),
      /pending transaction/,
    );
    await assert.rejects(() => transactions.requestBroadcast(tenant, tx.id), /not signed/);
    await db!.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'signed',
        signed: { raw: '0x1234', txHash: '0x' + 'ab'.repeat(32), encoding: 'hex' },
        tx_hash: '0x' + 'ab'.repeat(32),
      },
    });
    const requests = await Promise.all(
      Array.from({ length: 5 }, () => transactions.requestBroadcast(tenant, tx.id)),
    );
    assert(requests.every((t) => t.status === 'queued' && t.broadcast_generation === 1));
    assert.equal(await db!.outbox.count({ where: { dedupe_key: `broadcast-${tx.id}-1` } }), 1);
    await db!.transaction.update({ where: { id: tx.id }, data: { status: 'attention' } });
    await assert.rejects(
      () => transactions.createTransaction(tenant, wallet.id, 'payment-2', intent),
      /pending transaction/,
    );
    assert.equal((await transactions.requestBroadcast(tenant, tx.id)).broadcast_generation, 2);
    const auth = new MessageAuth('b'.repeat(64));
    const worker = new WalletProcessor(
      new WalletWorkflowService(db as WalletPrismaService, {} as ChainRpcService, {
        seedId: 'test',
        ethereumChainId: '11155111',
        solanaGenesisHash: 'devnet',
      }),
      auth,
    );
    const deliver = async (
      generation: number,
      revision: number,
      status: Extract<Message, { type: 'broadcast.updated' }>['status'],
      id = randomUUID(),
    ) => {
      inboxIds.push(id);
      const payload: Message = {
        type: 'broadcast.updated',
        transactionId: tx.id,
        generation,
        revision,
        status,
        attempts: 3,
        lastError: null,
      };
      await worker.process({
        id,
        name: payload.type,
        data: auth.seal(payload, id),
        opts: { attempts: 8 },
        attemptsMade: 0,
      } as Job);
      return id;
    };
    const eventId = await deliver(2, 3, 'submitted');
    await deliver(2, 3, 'submitted', eventId);
    await deliver(2, 2, 'attention');
    await deliver(1, 100, 'confirmed');
    assert.equal((await transactions.getTransaction(tenant, tx.id)).status, 'submitted');
    await deliver(2, 4, 'attention');
    await assert.rejects(
      () => transactions.createTransaction(tenant, wallet.id, 'payment-2', intent),
      /pending transaction/,
    );
    await deliver(2, 5, 'confirmed');
    await deliver(2, 6, 'broadcasting');
    assert.equal((await transactions.getTransaction(tenant, tx.id)).status, 'confirmed');
    assert.equal(
      (await transactions.createTransaction(tenant, wallet.id, 'payment-2', intent)).status,
      'preparing',
    );
  },
);
