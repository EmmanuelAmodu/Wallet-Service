import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Database, lock, lockTransaction } from '../../../packages/database/src/client';
import { Chain, derivationPath, Transfer } from '../../../packages/shared/src/contracts';
import { canonical, QUEUES } from '../../../packages/queue/src/messages';
import { enqueue } from '../../../packages/queue/src/outbox';
import { networkFor } from '../../../packages/chain/src/config';

export const WALLET_CONFIG = 'WALLET_CONFIG';
export interface WalletConfig {
  seedId: string;
  ethereumChainId: string;
  solanaGenesisHash: string;
}
export const pendingStatuses = [
  'preparing',
  'signing',
  'signed',
  'queued',
  'broadcasting',
  'submitted',
  'attention',
];
@Injectable()
export class WalletService {
  constructor(
    @Inject(Database) readonly db: PrismaClient,
    @Inject(WALLET_CONFIG) private readonly config: WalletConfig,
  ) {}
  async createWallet(tenant: string, chain: Chain, externalId: string) {
    const network = networkFor(chain, this.config);
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['wallet', tenant, chain, network, externalId]));
      const existing = await db.wallet.findFirst({
        where: { tenant_id: tenant, external_id: externalId, chain, network },
      });
      if (existing) return existing;
      const [sequence] = await db.$queryRaw<
        { account: bigint }[]
      >`SELECT nextval('wallet_account_seq') AS account`;
      const account = Number(sequence.account),
        id = randomUUID();
      const wallet = await db.wallet.create({
        data: {
          id,
          tenant_id: tenant,
          external_id: externalId,
          chain,
          network,
          seed_id: this.config.seedId,
          account,
          path: derivationPath(chain, account),
          status: 'deriving',
        },
      });
      await enqueue(
        db,
        QUEUES.signer,
        {
          type: 'wallet.derive',
          walletId: id,
          request: { chain, account, seedId: wallet.seed_id },
        },
        `derive-${id}`,
      );
      return wallet;
    });
  }
  async getWallet(tenant: string, id: string) {
    const wallet = await this.db.wallet.findFirst({ where: { id, tenant_id: tenant } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }
  async createTransaction(
    tenant: string,
    walletId: string,
    idempotencyKey: string,
    intent: Transfer,
  ) {
    const requestHash = createHash('sha256').update(canonical({ walletId, intent })).digest('hex');
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['idempotency', tenant, idempotencyKey]));
      const existing = await db.transaction.findFirst({
        where: { tenant_id: tenant, idempotency_key: idempotencyKey },
      });
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ConflictException('Idempotency key already used for a different request');
        return existing;
      }
      await db.$queryRaw`SELECT id FROM wallets WHERE id=${walletId}::uuid AND tenant_id=${tenant} FOR UPDATE`;
      const wallet = await db.wallet.findFirst({ where: { id: walletId, tenant_id: tenant } });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.status !== 'ready') throw new ConflictException('Wallet address is not ready');
      if (wallet.chain !== intent.chain)
        throw new BadRequestException('Wallet and transaction chain mismatch');
      if (wallet.network !== networkFor(intent.chain, this.config))
        throw new ConflictException('Wallet belongs to a different configured network');
      if (
        await db.transaction.findFirst({
          where: { wallet_id: walletId, status: { in: pendingStatuses } },
        })
      )
        throw new ConflictException('Wallet has a pending transaction');
      const tx = await db.transaction.create({
        data: {
          id: randomUUID(),
          tenant_id: tenant,
          wallet_id: walletId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          intent: intent as Prisma.InputJsonValue,
          status: 'preparing',
        },
      });
      await enqueue(
        db,
        QUEUES.wallet,
        { type: 'transaction.prepare', transactionId: tx.id },
        `prepare-${tx.id}`,
      );
      return tx;
    });
  }
  async getTransaction(tenant: string, id: string) {
    const tx = await this.db.transaction.findFirst({ where: { id, tenant_id: tenant } });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }
  async requestBroadcast(tenant: string, id: string) {
    return this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const tx = await db.transaction.findFirst({ where: { id, tenant_id: tenant } });
      if (!tx) throw new NotFoundException('Transaction not found');
      if (['queued', 'broadcasting', 'submitted', 'confirmed', 'failed'].includes(tx.status))
        return tx;
      if (!['signed', 'attention'].includes(tx.status) || !tx.signed)
        throw new ConflictException('Transaction is not signed');
      const updated = await db.transaction.update({
        where: { id },
        data: { status: 'queued', broadcast_generation: { increment: 1 }, last_error: null },
      });
      await enqueue(
        db,
        QUEUES.broadcast,
        {
          type: 'broadcast.requested',
          transactionId: id,
          generation: updated.broadcast_generation,
        },
        `broadcast-${id}-${updated.broadcast_generation}`,
      );
      return updated;
    });
  }
  async requestRefresh(tenant: string, id: string) {
    return this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const tx = await db.transaction.findFirst({ where: { id, tenant_id: tenant } });
      if (!tx) throw new NotFoundException('Transaction not found');
      if (['confirmed', 'failed'].includes(tx.status)) return tx;
      if (!tx.signed || !['queued', 'broadcasting', 'submitted', 'attention'].includes(tx.status))
        throw new ConflictException('Transaction has not been queued for broadcast');
      await enqueue(
        db,
        QUEUES.broadcast,
        {
          type: 'broadcast.confirm',
          transactionId: id,
          generation: tx.broadcast_generation,
          poll: 0,
          monitorId: randomUUID(),
        },
        `refresh-${id}-${randomUUID()}`,
      );
      return tx;
    });
  }
}
