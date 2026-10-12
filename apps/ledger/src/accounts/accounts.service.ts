import { Injectable } from '@nestjs/common';
import type {
  LedgerAccount,
  LedgerAccountOwnerKind,
  LedgerAccountType,
  LedgerEntrySide,
  Prisma,
} from '.prisma/ledger-client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lock } from '../../../../packages/database/src/locks.js';
import { canonical } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { chainSchema, isEvmChain } from '../../../../packages/shared/src/contracts.js';

export type AccountSpec = {
  domainId: string;
  chain: string;
  network: string;
  assetId: string;
  type: LedgerAccountType;
  ownerKind: LedgerAccountOwnerKind;
  ownerId: string;
  normalSide: LedgerEntrySide;
};

export const accountNormalSides: Record<LedgerAccountType, LedgerEntrySide> = {
  custody_deposit: 'debit',
  custody_hot: 'debit',
  custody_management: 'debit',
  custody_in_transit: 'debit',
  custody_rent: 'debit',
  customer_available: 'credit',
  customer_reserved: 'credit',
  customer_frozen: 'credit',
  customer_pending: 'credit',
  fee_expense: 'debit',
  fee_revenue: 'credit',
  equity: 'credit',
  deficit: 'debit',
  reconciliation: 'debit',
};

const specSchema = z.object({
  domainId: z.string().min(1).max(128),
  chain: chainSchema,
  network: z.string().min(1).max(128),
  assetId: z.string().min(1).max(256),
  type: z.enum(Object.keys(accountNormalSides) as [LedgerAccountType, ...LedgerAccountType[]]),
  ownerKind: z.enum(['customer', 'wallet', 'exchange']),
  ownerId: z.string().min(1).max(256),
  normalSide: z.enum(['debit', 'credit']),
});

export function canonicalAccount(spec: AccountSpec): AccountSpec {
  const result = specSchema.safeParse(spec);
  if (!result.success) throw new ActionRejectedError('Invalid journal account identity');
  const account = result.data;
  if (account.normalSide !== accountNormalSides[account.type])
    throw new ActionRejectedError('Account normal side does not match its type');
  const asset = new RegExp(
    `^token:${account.chain}:(?:native|erc20:0x[0-9a-fA-F]{40}|` +
      'spl:[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44})$',
  );
  if (!asset.test(account.assetId))
    throw new ActionRejectedError('Account asset does not match its canonical chain');
  if (
    (account.assetId.includes(':erc20:') && !isEvmChain(account.chain)) ||
    (account.assetId.includes(':spl:') && account.chain !== 'solana')
  )
    throw new ActionRejectedError('Account token standard does not match its canonical chain');
  if (account.assetId.includes(':erc20:'))
    account.assetId = account.assetId.replace(/0x[0-9a-fA-F]{40}$/, (address) =>
      address.toLowerCase(),
    );
  if (account.ownerKind !== 'exchange') {
    const id = z.uuid().safeParse(account.ownerId);
    if (!id.success) throw new ActionRejectedError('Customer and wallet account owners need UUIDs');
    account.ownerId = account.ownerId.toLowerCase();
  }
  const expectedOwner = account.type.startsWith('customer_')
    ? 'customer'
    : ['custody_deposit', 'custody_hot', 'custody_management', 'custody_rent'].includes(
          account.type,
        )
      ? 'wallet'
      : ['fee_expense', 'fee_revenue', 'equity'].includes(account.type)
        ? 'exchange'
        : undefined;
  if (expectedOwner && account.ownerKind !== expectedOwner)
    throw new ActionRejectedError('Account owner does not match its type');
  return account;
}

export function journalAccountKey(spec: AccountSpec) {
  return `exchange:${createHash('sha256')
    .update(canonical(canonicalAccount(spec)))
    .digest('hex')}`;
}

@Injectable()
export class AccountsService {
  async ensure(tx: Prisma.TransactionClient, spec: AccountSpec): Promise<LedgerAccount> {
    const account = canonicalAccount(spec);
    const key = journalAccountKey(account);
    await lock(tx, `exchange-domain:${account.domainId}`);
    await lock(tx, `ledger-account-${key}`);
    const existing = await tx.ledgerAccount.findUnique({ where: { account_key: key } });
    if (existing) return existing;
    return tx.ledgerAccount.create({
      data: {
        id: randomUUID(),
        account_key: key,
        domain_id: account.domainId,
        chain: account.chain,
        network: account.network,
        asset_id: account.assetId,
        type: account.type,
        owner_kind: account.ownerKind,
        owner_id: account.ownerId,
        normal_side: account.normalSide,
      },
    });
  }
}
