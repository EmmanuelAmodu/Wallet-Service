import { Injectable, NotFoundException } from '@nestjs/common';
import { lock } from '../../../../packages/database/src/locks.js';
import type { ExchangeEvent } from '../../../../packages/queue/src/exchange-contracts.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { QUEUES } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { chainFamily } from '../../../../packages/shared/src/contracts.js';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import type { ExchangeWalletRole } from '.prisma/ledger-client';
import { consumeExchangeEvent } from './exchange-inbox.js';
import { resultIdentity } from './events.js';

@Injectable()
export class ExchangeRegistryService {
  constructor(private readonly db: LedgerPrismaService) {}

  async handle(event: ExchangeEvent) {
    if (
      event.type !== 'customer-wallet.registry.requested.v1' &&
      event.type !== 'custody-wallet.registry.requested.v1'
    )
      throw new ActionRejectedError('Unsupported registry event');
    return this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-domain:${event.domainId}`);
      await consumeExchangeEvent(tx, event, async () => {
        const data = event.data;
        const customer = event.type === 'customer-wallet.registry.requested.v1';
        const role: ExchangeWalletRole = customer ? 'customer' : event.data.role;
        const customerId = customer ? event.customerId! : null;
        const key =
          chainFamily(data.chain) === 'ethereum' ? data.address.toLowerCase() : data.address;
        const existing = await tx.exchangeWallet.findUnique({
          where: { wallet_id: data.walletId },
        });
        const identity = {
          domain_id: event.domainId,
          customer_id: customerId,
          chain: data.chain,
          network: data.network,
          address: data.address,
          address_key: key,
          hot_wallet_id: customer ? event.data.hotWalletId : null,
          role,
          account: data.account,
          reset_epoch: event.resetEpoch,
        };
        if (existing) {
          for (const field of [
            'domain_id',
            'customer_id',
            'chain',
            'network',
            'address_key',
            'hot_wallet_id',
            'role',
            'account',
            'reset_epoch',
          ] as const)
            if (existing[field] !== identity[field])
              throw new ActionRejectedError('Published wallet registry identity is immutable');
          if (data.registryRevision < existing.registry_revision) return;
        }
        if (customer) {
          const hot = await tx.exchangeWallet.findUnique({
            where: { wallet_id: event.data.hotWalletId },
          });
          if (
            !hot ||
            hot.role !== 'hot' ||
            hot.domain_id !== event.domainId ||
            hot.chain !== data.chain ||
            hot.network !== data.network ||
            hot.reset_epoch !== event.resetEpoch
          )
            throw new ActionRejectedError('Customer registry requires its registered hot wallet');
          await tx.exchangeCustomer.upsert({
            where: { customer_id: customerId! },
            create: { customer_id: customerId!, domain_id: event.domainId, state: 'active' },
            update: {},
          });
          const owner = await tx.exchangeCustomer.findUniqueOrThrow({
            where: { customer_id: customerId! },
          });
          if (owner.domain_id !== event.domainId)
            throw new ActionRejectedError('Customer belongs to a different custody domain');
        }
        await tx.exchangeWallet.upsert({
          where: { wallet_id: data.walletId },
          create: {
            wallet_id: data.walletId,
            ...identity,
            registry_revision: data.registryRevision,
          },
          update: { registry_revision: data.registryRevision },
        });
        if (customer)
          await enqueue(
            tx,
            QUEUES.wallet,
            {
              ...resultIdentity(event),
              type: 'customer-wallet.registry.acknowledged.v1',
              data: {
                walletId: data.walletId,
                consumer: 'ledger',
                registryRevision: data.registryRevision,
                status: 'ready',
              },
            },
            `registry-ledger-${data.walletId}-${data.registryRevision}`,
          );
      });
    });
  }

  async balances(domainId: string, customerId: string) {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-domain:${domainId}`);
      const customer = await tx.exchangeCustomer.findUnique({
        where: { customer_id: customerId },
      });
      if (!customer || customer.domain_id !== domainId)
        throw new NotFoundException('Customer not found');
      const accounts = await tx.ledgerAccount.findMany({
        where: { domain_id: domainId, owner_kind: 'customer', owner_id: customerId },
      });
      const balances = new Map<string, Record<string, string>>();
      for (const account of accounts) {
        const key = JSON.stringify([account.chain, account.network, account.asset_id]);
        const row = balances.get(key) ?? {
          chain: account.chain,
          network: account.network,
          assetId: account.asset_id,
          available: '0',
          reserved: '0',
          frozen: '0',
          pending: '0',
        };
        const entry = await tx.ledgerEntry.findFirst({
          where: { account_id: account.id },
          orderBy: { sequence: 'desc' },
        });
        const type = account.type.replace('customer_', '');
        if (['available', 'reserved', 'frozen', 'pending'].includes(type))
          row[type] = entry?.balance_after.toFixed(0) ?? '0';
        balances.set(key, row);
      }
      const pending = await tx.deposit.findMany({
        where: { domain_id: domainId, customer_id: customerId, state: 'pending' },
      });
      for (const deposit of pending) {
        if (!deposit.amount) continue;
        const key = JSON.stringify([deposit.chain, deposit.network, deposit.asset_id]);
        const row = balances.get(key) ?? {
          chain: deposit.chain,
          network: deposit.network,
          assetId: deposit.asset_id,
          available: '0',
          reserved: '0',
          frozen: '0',
          pending: '0',
        };
        row.pending = (BigInt(row.pending) + BigInt(deposit.amount.toFixed(0))).toString();
        balances.set(key, row);
      }
      return { customerId, domainId, state: customer.state, balances: [...balances.values()] };
    });
  }
}
