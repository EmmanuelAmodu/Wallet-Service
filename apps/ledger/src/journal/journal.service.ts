import { Injectable } from '@nestjs/common';
import { Prisma as DecimalPrisma } from '@prisma/client';
import type { JournalBatch, LedgerEntrySide, Prisma } from '.prisma/ledger-client';
import { createHash, randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import { canonical } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  AccountSpec,
  AccountsService,
  canonicalAccount,
  journalAccountKey,
} from '../accounts/accounts.service.js';

export const MAX_JOURNAL_AMOUNT = (1n << 256n) - 1n;
export type JournalPosting = { account: AccountSpec; side: LedgerEntrySide; amount: bigint };
export type JournalRequest = {
  key: string;
  domainId: string;
  operationId?: string;
  revision: number;
  kind: string;
  postings: JournalPosting[];
  reversalOfBatchId?: string;
};

function assertAmount(value: bigint, allowNegative = false) {
  if (
    typeof value !== 'bigint' ||
    (!allowNegative && value <= 0n) ||
    value > MAX_JOURNAL_AMOUNT ||
    value < -MAX_JOURNAL_AMOUNT
  )
    throw new ActionRejectedError('Journal amounts must be bounded integer base units');
}

function normalizedPostings(request: JournalRequest) {
  if (!request.postings.length || request.postings.length > 1000)
    throw new ActionRejectedError('A journal batch requires between 1 and 1000 postings');
  const totals = new Map<string, JournalPosting>();
  const assetTotals = new Map<string, bigint>();
  for (const posting of request.postings) {
    assertAmount(posting.amount);
    if (!['debit', 'credit'].includes(posting.side))
      throw new ActionRejectedError('Invalid journal posting side');
    const account = canonicalAccount(posting.account);
    if (account.domainId !== request.domainId)
      throw new ActionRejectedError('Journal cannot cross exchange custody domains');
    const key = `${journalAccountKey(account)}:${posting.side}`;
    const amount = (totals.get(key)?.amount ?? 0n) + posting.amount;
    assertAmount(amount);
    totals.set(key, { account, side: posting.side, amount });
    const assetKey = canonical([account.chain, account.network, account.assetId]);
    assetTotals.set(
      assetKey,
      (assetTotals.get(assetKey) ?? 0n) +
        (posting.side === 'debit' ? posting.amount : -posting.amount),
    );
  }
  if ([...assetTotals.values()].some((total) => total !== 0n))
    throw new ActionRejectedError('Journal postings must balance separately for each asset');
  return [...totals.values()].sort((a, b) =>
    `${journalAccountKey(a.account)}:${a.side}`.localeCompare(
      `${journalAccountKey(b.account)}:${b.side}`,
    ),
  );
}

@Injectable()
export class JournalService {
  constructor(private readonly accounts: AccountsService) {}

  async balance(tx: Prisma.TransactionClient, spec: AccountSpec): Promise<bigint> {
    const account = await this.accounts.ensure(tx, spec);
    const latest = await tx.ledgerEntry.findFirst({
      where: { account_id: account.id },
      orderBy: { sequence: 'desc' },
    });
    return latest ? BigInt(latest.balance_after.toFixed(0)) : 0n;
  }

  async post(tx: Prisma.TransactionClient, request: JournalRequest): Promise<JournalBatch> {
    if (
      !request.key ||
      request.key.length > 512 ||
      !request.kind ||
      request.kind.length > 64 ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0
    )
      throw new ActionRejectedError('Invalid journal batch identity');
    const postings = normalizedPostings(request);
    const digest = createHash('sha256')
      .update(
        canonical({
          domainId: request.domainId,
          operationId: request.operationId ?? null,
          revision: request.revision,
          kind: request.kind,
          reversalOfBatchId: request.reversalOfBatchId ?? null,
          postings: postings.map((posting) => ({
            account: posting.account,
            side: posting.side,
            amount: posting.amount.toString(),
          })),
        }),
      )
      .digest('hex');
    await lock(tx, `exchange-domain:${request.domainId}`);
    await lock(tx, `journal-batch:${request.key}`);
    const existing = await tx.journalBatch.findUnique({ where: { key: request.key } });
    if (existing) {
      if (existing.request_digest !== digest)
        throw new ActionRejectedError('Journal key was reused for different postings');
      return existing;
    }
    if (request.reversalOfBatchId) {
      const original = await tx.journalBatch.findUnique({
        where: { id: request.reversalOfBatchId },
      });
      if (!original || original.domain_id !== request.domainId)
        throw new ActionRejectedError('Journal reversal must reference a batch in this domain');
    }
    // Lock every account in one order before reading any account tail or appending entries.
    const keys = [...new Set(postings.map((posting) => journalAccountKey(posting.account)))].sort();
    for (const key of keys) await lock(tx, `ledger-account-${key}`);
    const batch = await tx.journalBatch.create({
      data: {
        id: randomUUID(),
        key: request.key,
        domain_id: request.domainId,
        operation_id: request.operationId,
        revision: request.revision,
        kind: request.kind,
        request_digest: digest,
        reversal_of_batch_id: request.reversalOfBatchId,
      },
    });
    for (const posting of postings) {
      const account = await this.accounts.ensure(tx, posting.account);
      const previous = await tx.ledgerEntry.findFirst({
        where: { account_id: account.id },
        orderBy: { sequence: 'desc' },
      });
      const before = previous ? BigInt(previous.balance_after.toFixed(0)) : 0n;
      const after =
        before + (posting.side === account.normal_side ? posting.amount : -posting.amount);
      assertAmount(after, true);
      if (account.type.startsWith('customer_') && after < 0n)
        throw new ActionRejectedError('Customer liability balance cannot become negative');
      await tx.ledgerEntry.create({
        data: {
          id: randomUUID(),
          account_id: account.id,
          batch_id: batch.id,
          revision: request.revision,
          account_key: account.account_key,
          sequence: (previous?.sequence ?? 0n) + 1n,
          asset: account.asset_id,
          side: posting.side,
          amount: new DecimalPrisma.Decimal(posting.amount.toString()),
          balance_after: new DecimalPrisma.Decimal(after.toString()),
          previous_entry_id: previous?.id,
        },
      });
    }
    return batch;
  }
}
