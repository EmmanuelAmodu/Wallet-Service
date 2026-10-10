import { Inject, Injectable, HttpException, Optional } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Prisma, Wallet } from '@prisma/client';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock, lockTransaction } from '../../../../packages/database/src/locks.js';
import {
  Message,
  MessageAuth,
  derivationRequestDigest,
  walletDerivedSchema,
  walletRejectedSchema,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import {
  chainSchema,
  signSchema,
  transferSchema,
} from '../../../../packages/shared/src/contracts.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import {
  canonicalizeDerivedAddress,
  coreDerivationPath,
} from '../../../../packages/chain/src/coin-metadata.js';
import { exchangeEventSchema } from '../../../../packages/queue/src/exchange-contracts.js';
import { CustodyService } from '../custody/custody.service.js';
import { ExchangeMessagingService } from '../exchange-messaging/exchange-messaging.service.js';
import { ExchangeCustomersService } from '../customers/customers.service.js';

@Injectable()
export class WalletWorkflowService {
  constructor(
    @Inject(WalletPrismaService) private readonly db: WalletPrismaService,
    @Inject(ChainRpcService) private readonly rpc: ChainRpcService,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
    @Optional() private readonly exchange?: ExchangeMessagingService,
    @Optional() private readonly custody?: CustodyService,
    @Optional() private readonly customers?: ExchangeCustomersService,
    @Optional() private readonly auth?: MessageAuth,
  ) {}

  async handle(message: Message, messageId: string, finalAttempt: boolean) {
    if (
      [
        'transaction.prepare',
        'transaction.signed',
        'transaction.rejected',
        'broadcast.updated',
      ].includes(message.type) &&
      'transactionId' in message
    ) {
      const owned = await this.db.transaction.findUnique({
        where: { id: message.transactionId },
        select: { wallet: { select: { custody_role: true } } },
      });
      if (owned && owned.wallet.custody_role !== 'legacy')
        throw new ActionRejectedError(
          'Custody transactions require independently authorized attempt results',
        );
    }
    if (message.type === 'custody.assignment.issue') {
      if (!this.customers) throw new Error('Custody assignment handler is unavailable');
      await this.customers.issueAssignment(message.assignmentId, message.domainId);
      return;
    }
    if (message.type === 'custody.bootstrap' || message.type === 'custody.management.create') {
      if (!this.custody || !this.customers)
        throw new Error('Custody command handler is unavailable');
      if (message.domainId !== this.config.domainId)
        throw new ActionRejectedError('Custody command domain mismatch');
      await this.db.$transaction(async (db) => {
        await lock(db, `inbox-${messageId}`);
        if (await db.inbox.findUnique({ where: { id: messageId } })) return;
        if (message.type === 'custody.bootstrap') await this.custody!.bootstrap(db);
        else
          await this.custody!.createManagement(db, message.chain, message.network, message.account);
        await db.inbox.create({ data: { id: messageId } });
      });
      if (message.type === 'custody.bootstrap')
        await this.customers.resumeIssuance(message.domainId, message.commandId);
      return;
    }
    if (message.type === 'transaction.prepare') {
      try {
        await this.prepare(message.transactionId);
      } catch (error) {
        const permanent =
          error instanceof ActionRejectedError ||
          (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500);
        if (permanent || finalAttempt)
          await this.db.transaction.updateMany({
            where: { id: message.transactionId, status: 'preparing' },
            data: {
              status: 'rejected',
              last_error:
                'Transaction preparation failed; inspect RPC configuration, funds, and request',
            },
          });
        if (permanent) throw new ActionRejectedError('Transaction preparation rejected');
        throw new Error('Transaction preparation failed', { cause: error });
      }
      return;
    }
    if (
      ![
        'wallet.derived',
        'wallet.rejected',
        'transaction.signed',
        'transaction.rejected',
        'broadcast.updated',
      ].includes(message.type)
    )
      throw new ActionRejectedError('Unsupported wallet action');
    await this.db.$transaction(async (db) => {
      await lock(db, `inbox-${messageId}`);
      if (await db.inbox.findUnique({ where: { id: messageId } })) return;
      if (message.type === 'broadcast.updated') {
        await db.transaction.updateMany({
          where: {
            id: message.transactionId,
            broadcast_generation: message.generation,
            broadcast_revision: { lt: message.revision },
            status: { in: ['queued', 'broadcasting', 'submitted', 'attention'] },
          },
          data: {
            status: message.status,
            broadcast_revision: message.revision,
            broadcast_attempts: message.attempts,
            last_error: message.lastError,
          },
        });
      } else if (message.type === 'wallet.derived') {
        walletDerivedSchema.parse(message);
        await lock(db, `wallet-derive:${message.walletId}`);
        const wallet = await db.wallet.findUnique({ where: { id: message.walletId } });
        if (wallet && ['deriving', 'ready'].includes(wallet.status)) {
          await this.validateDerivation(wallet, message);
          let address: string;
          try {
            address = await canonicalizeDerivedAddress(
              message.request.chain,
              message.network,
              message.address,
            );
          } catch {
            throw new ActionRejectedError('Signer returned an invalid chain address');
          }
          if (wallet.status === 'ready' && wallet.address !== address)
            throw new ActionRejectedError('Signer derivation mismatch');
          if (wallet.status === 'deriving')
            await db.wallet.update({
              where: { id: wallet.id },
              data: { status: 'ready', address, last_error: null },
            });
          if (wallet.custody_role !== 'legacy') {
            if (!this.custody || !this.exchange)
              throw new Error('Custody registry publisher is unavailable');
            const registryRevision = Math.max(1, wallet.registry_revision);
            const event = exchangeEventSchema.parse({
              eventId: wallet.derivation_request_id,
              schemaVersion: 1,
              resetEpoch: wallet.reset_epoch,
              occurredAt: wallet.created_at.toISOString(),
              domainId: wallet.custody_domain_id,
              correlationId: wallet.derivation_request_id,
              causationId: wallet.derivation_request_id,
              aggregateId: wallet.id,
              revision: registryRevision,
              ...(wallet.customer_id ? { customerId: wallet.customer_id } : {}),
              type:
                wallet.custody_role === 'customer_deposit'
                  ? 'customer-wallet.registry.requested.v1'
                  : 'custody-wallet.registry.requested.v1',
              data: {
                walletId: wallet.id,
                chain: wallet.chain,
                network: wallet.network,
                address,
                account: wallet.account,
                registryRevision,
                ...(wallet.custody_role === 'customer_deposit'
                  ? { hotWalletId: wallet.hot_wallet_id }
                  : { role: wallet.custody_role }),
              },
            });
            await this.exchange.publishRegistry(
              event as Parameters<ExchangeMessagingService['publishRegistry']>[0],
              db,
            );
            await this.custody.markPublished(db, wallet.id, registryRevision);
          } else
            await enqueue(
              db,
              QUEUES.ledger,
              {
                type: 'ledger.wallet.registered',
                walletId: wallet.id,
                chain: chainSchema.parse(wallet.chain),
                network: wallet.network,
                address,
              },
              `ledger-wallet-${wallet.id}`,
            );
        }
      } else if (message.type === 'wallet.rejected') {
        walletRejectedSchema.parse(message);
        await lock(db, `wallet-derive:${message.walletId}`);
        const wallet = await db.wallet.findUnique({ where: { id: message.walletId } });
        if (wallet) await this.validateDerivation(wallet, message);
        await db.wallet.updateMany({
          where: { id: message.walletId, status: 'deriving' },
          data: { status: 'rejected', last_error: 'Signer rejected address derivation' },
        });
      } else if (message.type === 'transaction.signed') {
        await db.transaction.updateMany({
          where: { id: message.transactionId, status: 'signing' },
          data: {
            status: 'signed',
            signed: message.signed,
            tx_hash: message.signed.txHash,
            last_error: null,
          },
        });
      } else if (message.type === 'transaction.rejected') {
        await db.transaction.updateMany({
          where: { id: message.transactionId, status: 'signing' },
          data: { status: 'rejected', last_error: 'Signer rejected transaction' },
        });
      }
      await db.inbox.create({ data: { id: messageId } });
    });
  }

  private async validateDerivation(
    wallet: Wallet,
    message: Extract<Message, { type: 'wallet.derived' | 'wallet.rejected' }>,
  ) {
    const chain = chainSchema.parse(wallet.chain);
    const domainId = wallet.custody_domain_id ?? this.config.domainId ?? 'legacy-internal';
    const expected = {
      walletId: wallet.id,
      requestId: wallet.derivation_request_id!,
      domainId,
      network: wallet.network,
      path: wallet.path,
      role: wallet.custody_role,
      request: { chain, seedId: wallet.seed_id, account: wallet.account },
    };
    if (
      !wallet.active ||
      wallet.seed_id !== this.config.seedId ||
      (this.config.domainId && domainId !== this.config.domainId) ||
      wallet.network !== networkFor(chain, this.config) ||
      (this.auth && wallet.reset_epoch !== this.auth.resetEpoch) ||
      !wallet.derivation_request_id ||
      !wallet.derivation_request_digest ||
      message.domainId !== domainId ||
      message.requestId !== expected.requestId ||
      message.network !== expected.network ||
      message.path !== expected.path ||
      message.role !== expected.role ||
      message.request.chain !== chain ||
      message.request.seedId !== wallet.seed_id ||
      message.request.account !== wallet.account ||
      message.requestDigest !== wallet.derivation_request_digest ||
      derivationRequestDigest(expected) !== message.requestDigest ||
      (await coreDerivationPath(chain, wallet.account, wallet.network)) !== wallet.path
    )
      throw new ActionRejectedError('Signer derivation identity mismatch');
  }

  private async prepare(id: string) {
    const tx = await this.db.transaction.findUnique({ where: { id }, include: { wallet: true } });
    if (!tx || tx.status !== 'preparing') return;
    const wallet = tx.wallet,
      chain = chainSchema.parse(wallet.chain);
    if (wallet.custody_role !== 'legacy')
      throw new ActionRejectedError(
        'Custody execution requires an authorized sweep or withdrawal operation',
      );
    if (!wallet.address || wallet.network !== networkFor(chain, this.config))
      throw new ActionRejectedError('Wallet network mismatch');
    const prepared = await this.rpc.prepare(wallet.address, transferSchema.parse(tx.intent));
    const request = signSchema.parse({
      wallet: {
        chain,
        network: wallet.network,
        address: wallet.address,
        account: wallet.account,
        seedId: wallet.seed_id,
      },
      transaction: prepared,
    });
    await this.db.$transaction(async (db) => {
      await lockTransaction(db, id);
      const updated = await db.transaction.updateMany({
        where: { id, status: 'preparing' },
        data: { status: 'signing', prepared: prepared as Prisma.InputJsonValue },
      });
      if (updated.count)
        await enqueue(
          db,
          QUEUES.signer,
          { type: 'transaction.sign', transactionId: id, request },
          `sign-${id}`,
        );
    });
  }
}
