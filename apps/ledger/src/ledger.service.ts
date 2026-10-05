import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Prisma as LedgerPrisma } from '.prisma/ledger-client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../packages/database/src/locks.js';
import { ActionRejectedError } from '../../../packages/shared/src/action-rejected.error.js';
import {
  LedgerActivity,
  LedgerWalletRegistration,
} from '../../../packages/shared/src/activity-contracts.js';
import {
  Chain,
  chainFamily,
  chainSchema,
  canonicalTransactionHash,
  resolveChainIdentifier,
} from '../../../packages/shared/src/contracts.js';
import { LedgerPrismaService } from './prisma/prisma.service.js';

type AccountKind = 'wallet' | 'clearing';
type BalanceState = 'provisional' | 'confirmed';
type EntrySide = 'debit' | 'credit';
type PostingKind = 'wallet' | 'clearing' | 'reversal';
type PostingAccount = {
  key: string;
  kind: AccountKind;
  balanceState: BalanceState;
  asset: string;
  walletId?: string;
};

type BalanceDelta = { walletId: string; asset: string; amount: bigint };

function addressKey(chain: Chain, address: string) {
  if (chainFamily(chain) === 'ethereum') return address.toLowerCase();
  if (chainFamily(chain) === 'bitcoin' && /^(bc1|tb1|bcrt1)/i.test(address))
    return address.toLowerCase();
  return address;
}

function parseWalletIdentifier(identifier: string, expectedChain: Chain) {
  const match = /^wallet:([^:]+):(.+)$/.exec(identifier);
  const chain = match && resolveChainIdentifier(match[1]);
  if (!match || chain !== expectedChain)
    throw new ActionRejectedError('Activity wallet identifier does not match its chain');
  return { chain, address: match[2] };
}

function accountKey(
  kind: AccountKind,
  chain: Chain,
  network: string,
  asset: string,
  balanceState: BalanceState,
  walletId?: string,
) {
  return kind === 'wallet'
    ? `wallet:${walletId}:${asset}:${balanceState}`
    : `clearing:${chain}:${network}:${asset}:${balanceState}`;
}

function assertLedgerInteger(amount: bigint) {
  if ((amount < 0n ? -amount : amount).toString().length > 78)
    throw new ActionRejectedError('Ledger amount exceeds supported precision');
}

function decimalFromInteger(amount: bigint) {
  assertLedgerInteger(amount);
  return new Prisma.Decimal(amount.toString());
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: LedgerPrismaService) {}

  async registerWallet(wallet: LedgerWalletRegistration) {
    return this.db.ledgerWallet.upsert({
      where: { wallet_id: wallet.walletId },
      create: {
        wallet_id: wallet.walletId,
        chain: wallet.chain,
        network: wallet.network,
        address: wallet.address,
        address_key: addressKey(wallet.chain, wallet.address),
      },
      update: {
        chain: wallet.chain,
        network: wallet.network,
        address: wallet.address,
        address_key: addressKey(wallet.chain, wallet.address),
      },
    });
  }

  async balances(walletId: string) {
    const wallet = await this.db.ledgerWallet.findFirst({
      where: { wallet_id: walletId },
    });
    if (!wallet) throw new NotFoundException('Ledger wallet not found');
    const latestEntries = await this.db.ledgerEntry.findMany({
      where: { wallet_id: walletId, account_kind: 'wallet' },
      orderBy: [{ account_key: 'asc' }, { sequence: 'desc' }],
      distinct: ['account_key'],
    });
    const balances = new Map<string, { confirmed: string; provisional: string }>();
    for (const entry of latestEntries) {
      const balance = balances.get(entry.asset) ?? { confirmed: '0', provisional: '0' };
      balance[entry.balance_state as BalanceState] = entry.balance_after.toFixed(0);
      balances.set(entry.asset, balance);
    }
    return {
      walletId: wallet.wallet_id,
      chain: wallet.chain,
      network: wallet.network,
      balances: [...balances.entries()].map(([asset, amount]) => ({ asset, ...amount })),
    };
  }

  async applyActivity(incomingActivity: LedgerActivity) {
    return this.db.$transaction(async (tx) => {
      const identity = JSON.stringify([
        incomingActivity.chain,
        incomingActivity.network,
        canonicalTransactionHash(incomingActivity.chain, incomingActivity.transactionHash),
      ]);
      await lock(tx, `ledger-activity-${identity}`);
      let activity = incomingActivity;
      let existing = await tx.ledgerActivity.findUnique({
        where: { identifier: activity.identifier },
      });
      if (!existing)
        existing = await tx.ledgerActivity.findFirst({
          where: {
            chain: activity.chain,
            network: activity.network,
            transaction_hash_key: canonicalTransactionHash(
              activity.chain,
              activity.transactionHash,
            ),
          },
        });
      if (existing && existing.identifier !== activity.identifier)
        activity = { ...activity, identifier: existing.identifier };
      const hasObservationSequence = activity.observationSequence !== undefined;
      if (!hasObservationSequence && existing && existing.observation_sequence > 0n)
        throw new ActionRejectedError(
          'Legacy activity cannot replace a sequenced observation; reconcile through ActivityListener',
        );
      const observationSequence = hasObservationSequence
        ? BigInt(activity.observationSequence!)
        : 0n;
      activity = { ...activity, observationSequence: observationSequence.toString() };
      let revision = existing?.revision ?? 0;

      if (existing) {
        if (hasObservationSequence && observationSequence <= existing.observation_sequence)
          return existing;
        const sameBlock =
          existing.block_hash === activity.blockHash &&
          existing.block_hash !== null &&
          activity.blockHash !== undefined;
        const bothUnmined = !existing.block_hash && !activity.blockHash;
        const terminal = ['finalized', 'failed', 'reverted'].includes(existing.state);
        if (
          !hasObservationSequence &&
          activity.state === 'observed' &&
          !sameBlock &&
          !bothUnmined &&
          !activity.canonicalReconciliation
        )
          return existing;
        const restoredFinality =
          existing.state === 'reverted' &&
          ['finalized', 'failed'].includes(activity.state) &&
          activity.blockHash !== undefined;

        if (terminal && activity.state === existing.state && (sameBlock || bothUnmined))
          return tx.ledgerActivity.update({
            where: { identifier: activity.identifier },
            data: {
              observation_sequence: observationSequence,
              canonical_reconciliation: activity.canonicalReconciliation ?? false,
            },
          });
        if (terminal && !restoredFinality && !(activity.canonicalReconciliation ?? false))
          return existing;
        if (terminal && activity.state === 'attention') return existing;
        if (activity.state === 'attention' && ['observed', 'attention'].includes(existing.state))
          return tx.ledgerActivity.update({
            where: { identifier: activity.identifier },
            data: {
              state: 'attention',
              observation_sequence: observationSequence,
              last_error: 'Finality polling exhausted',
            },
          });
        if (
          activity.state === 'observed' &&
          existing.state === 'attention' &&
          (sameBlock || bothUnmined)
        )
          return tx.ledgerActivity.update({
            where: { identifier: activity.identifier },
            data: this.activityData(activity, activity.state, existing.revision),
          });
        if (activity.state === existing.state && (sameBlock || bothUnmined)) {
          return tx.ledgerActivity.update({
            where: { identifier: activity.identifier },
            data: {
              observation_sequence: observationSequence,
              canonical_reconciliation: activity.canonicalReconciliation ?? false,
            },
          });
        }

        await this.reverseCurrentRevision(
          tx,
          activity.identifier,
          existing.revision,
          chainSchema.parse(existing.chain),
          existing.network,
        );
        revision = existing.revision + 1;
      }

      const state = activity.state;
      const deltas = state === 'reverted' ? [] : await this.resolveDeltas(tx, activity);
      const balanceState: BalanceState =
        state === 'observed' || state === 'attention' ? 'provisional' : 'confirmed';
      const record = await tx.ledgerActivity.upsert({
        where: { identifier: activity.identifier },
        create: this.activityData(activity, state, revision),
        update: this.activityData(activity, state, revision),
      });
      await this.postDoubleEntry(tx, activity, revision, balanceState, deltas);
      return record;
    });
  }

  private activityData(activity: LedgerActivity, state: LedgerActivity['state'], revision: number) {
    return {
      identifier: activity.identifier,
      chain: activity.chain,
      network: activity.network,
      transaction_hash: activity.transactionHash,
      transaction_hash_key: canonicalTransactionHash(activity.chain, activity.transactionHash),
      state,
      revision,
      observation_sequence: BigInt(activity.observationSequence ?? '0'),
      canonical_reconciliation: activity.canonicalReconciliation ?? false,
      block_hash: activity.blockHash ?? null,
      block_height: activity.blockHeight ? BigInt(activity.blockHeight) : null,
      completed_at_ms: BigInt(Math.trunc(activity.completedAtTimestamp)),
      source_status: activity.sourceStatus,
      payload: activity as unknown as Prisma.InputJsonValue,
      last_error: state === 'attention' ? 'Finality polling exhausted' : null,
      finalized_at: ['finalized', 'failed'].includes(state) ? new Date() : null,
    };
  }

  private async resolveDeltas(
    tx: LedgerPrisma.TransactionClient,
    activity: LedgerActivity,
  ): Promise<BalanceDelta[]> {
    const totals = new Map<string, BalanceDelta>();
    for (const change of activity.changes) {
      const identity = parseWalletIdentifier(change.wallet, activity.chain);
      const wallet = await tx.ledgerWallet.findUnique({
        where: {
          chain_network_address_key: {
            chain: activity.chain,
            network: activity.network,
            address_key: addressKey(activity.chain, identity.address),
          },
        },
      });
      if (!wallet) throw new ConflictException('Activity references an unregistered wallet');
      const key = `${wallet.wallet_id}:${change.asset}`;
      const amount = BigInt(change.amount);
      const previous = totals.get(key);
      const total = (previous?.amount ?? 0n) + amount;
      assertLedgerInteger(total);
      totals.set(key, {
        walletId: wallet.wallet_id,
        asset: change.asset,
        amount: total,
      });
    }
    return [...totals.values()].filter((delta) => delta.amount !== 0n);
  }

  private async postDoubleEntry(
    tx: LedgerPrisma.TransactionClient,
    activity: LedgerActivity,
    revision: number,
    balanceState: BalanceState,
    deltas: BalanceDelta[],
  ) {
    const netByAsset = new Map<string, bigint>();
    for (const delta of deltas) {
      const account: PostingAccount = {
        key: accountKey(
          'wallet',
          activity.chain,
          activity.network,
          delta.asset,
          balanceState,
          delta.walletId,
        ),
        kind: 'wallet',
        balanceState,
        asset: delta.asset,
        walletId: delta.walletId,
      };
      await this.appendEntry(tx, account, activity, revision, delta.amount, 'wallet');
      const net = (netByAsset.get(delta.asset) ?? 0n) + delta.amount;
      assertLedgerInteger(net);
      netByAsset.set(delta.asset, net);
    }

    for (const [asset, net] of netByAsset) {
      if (net === 0n) continue;
      const clearing: PostingAccount = {
        key: accountKey('clearing', activity.chain, activity.network, asset, balanceState),
        kind: 'clearing',
        balanceState,
        asset,
      };
      await this.appendEntry(tx, clearing, activity, revision, net, 'clearing');
    }
  }

  private async appendEntry(
    tx: LedgerPrisma.TransactionClient,
    account: PostingAccount,
    activity: LedgerActivity,
    revision: number,
    normalDelta: bigint,
    entryKind: PostingKind,
    reversalOfId?: string,
  ) {
    if (normalDelta === 0n) return;
    await lock(tx, `ledger-account-${account.key}`);
    const previous = await tx.ledgerEntry.findFirst({
      where: { account_key: account.key },
      orderBy: { sequence: 'desc' },
    });
    const normalSide: EntrySide = account.kind === 'wallet' ? 'debit' : 'credit';
    const side: EntrySide =
      normalDelta > 0n ? normalSide : normalSide === 'debit' ? 'credit' : 'debit';
    const amount = normalDelta < 0n ? -normalDelta : normalDelta;
    const previousBalance = previous ? BigInt(previous.balance_after.toFixed(0)) : 0n;
    const balanceAfter = previousBalance + normalDelta;
    assertLedgerInteger(amount);
    assertLedgerInteger(balanceAfter);
    const id = randomUUID();
    await tx.ledgerEntry.create({
      data: {
        id,
        activity_identifier: activity.identifier,
        revision,
        account_key: account.key,
        sequence: (previous?.sequence ?? 0n) + 1n,
        wallet_id: account.walletId,
        asset: account.asset,
        account_kind: account.kind,
        balance_state: account.balanceState,
        side,
        amount: decimalFromInteger(amount),
        balance_after: decimalFromInteger(balanceAfter),
        entry_kind: entryKind,
        previous_entry_id: previous?.id,
        reversal_of_id: reversalOfId,
      },
    });
  }

  private async reverseCurrentRevision(
    tx: LedgerPrisma.TransactionClient,
    identifier: string,
    revision: number,
    chain: Chain,
    network: string,
  ) {
    const entries = await tx.ledgerEntry.findMany({
      where: {
        activity_identifier: identifier,
        revision,
        entry_kind: { in: ['wallet', 'clearing'] },
      },
    });
    for (const entry of entries) {
      const kind = entry.account_kind as AccountKind;
      const normalSide = kind === 'wallet' ? 'debit' : 'credit';
      const amount = BigInt(entry.amount.toFixed(0));
      const normalDelta = entry.side === normalSide ? amount : -amount;
      const account: PostingAccount = {
        key: entry.account_key,
        kind,
        balanceState: entry.balance_state as BalanceState,
        asset: entry.asset,
        ...(entry.wallet_id ? { walletId: entry.wallet_id } : {}),
      };
      await this.appendEntry(
        tx,
        account,
        {
          identifier,
          chain,
          network,
          transactionHash: '',
          state: 'reverted',
          completedAtTimestamp: 0,
          sourceStatus: 'failed',
          changes: [],
        },
        revision + 1,
        -normalDelta,
        'reversal',
        entry.id,
      );
    }
  }
}
