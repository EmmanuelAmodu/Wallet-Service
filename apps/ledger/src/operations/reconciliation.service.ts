import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '.prisma/ledger-client';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
  CanonicalAsset,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { consumeExchangeEvent, exchangeDigest } from '../exchange/exchange-inbox.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { ReservationsService } from '../reservations/reservations.service.js';

interface Balance {
  type: string;
  owner_id: string;
  chain: string;
  network: string;
  asset_id: string;
  normal_side: string;
  balance: string;
  sequence: string;
}
export function reconcileAccounting(accounts: Balance[]) {
  const groups = new Map<
    string,
    {
      asset: CanonicalAsset;
      accounts: Record<string, string>;
      bookEquation: bigint;
      physicalCustody: bigint;
      liabilities: bigint;
    }
  >();
  for (const a of accounts) {
    const asset = { chain: a.chain, network: a.network, assetId: a.asset_id } as CanonicalAsset,
      key = canonical(asset);
    let group = groups.get(key);
    if (!group) {
      group = { asset, accounts: {}, bookEquation: 0n, physicalCustody: 0n, liabilities: 0n };
      groups.set(key, group);
    }
    const n = BigInt(a.balance);
    group.accounts[a.type] = (BigInt(group.accounts[a.type] ?? '0') + n).toString();
    group.bookEquation += a.normal_side === 'debit' ? n : -n;
    if (['custody_hot', 'custody_management', 'custody_deposit', 'custody_rent'].includes(a.type))
      group.physicalCustody += n;
    if (a.type.startsWith('customer_')) group.liabilities += n;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    bookEquation: g.bookEquation.toString(),
    physicalCustody: g.physicalCustody.toString(),
    liabilities: g.liabilities.toString(),
  }));
}
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly reservations: ReservationsService,
  ) {}

  async handle(event: ExchangeEvent) {
    if (event.type === 'operations.domain.resume.requested.v1') {
      await this.db.$transaction(async (tx) =>
        consumeExchangeEvent(tx, event, async () => {
          const records = await tx.custodyReconciliation.findMany({
              where: {
                run_id: { in: event.data.runIds },
                domain_id: event.domainId,
                reset_epoch: event.resetEpoch,
              },
            }),
            wallets = await tx.exchangeWallet.findMany({
              where: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
            });
          const watermark = String(
            await tx.journalBatch.count({ where: { domain_id: event.domainId } }),
          );
          let reason = 'Verified custody recovery evidence accepted';
          let accepted =
            records.length === event.data.runIds.length &&
            new Set(records.map((r) => r.wallet_id)).size === wallets.length &&
            wallets.every((w) => records.some((r) => r.wallet_id === w.wallet_id));
          for (const r of records) {
            const report = r.report as unknown as Extract<
              ExchangeEvent,
              { type: 'operations.custody.reconciled.v1' }
            >['data']['report'];
            const evidence = r.evidence as unknown as Extract<
              ExchangeEvent,
              { type: 'operations.custody.observed.v1' }
            >;
            if (
              report.journalWatermark !== watermark ||
              new Date(evidence.occurredAt).getTime() < Date.now() - 300000 ||
              report.wallets.some(
                (a) =>
                  a.status === 'unavailable' ||
                  BigInt(a.book) < 0n ||
                  BigInt(a.difference ?? '0') < 0n,
              ) ||
              report.totals.some(
                (a) => a.bookEquation !== '0' || BigInt(a.accounts.deficit ?? '0') !== 0n,
              )
            )
              accepted = false;
            const current = await tx.custodyReconciliation.findFirst({
              where: {
                domain_id: event.domainId,
                reset_epoch: event.resetEpoch,
                wallet_id: r.wallet_id,
              },
              orderBy: { created_at: 'desc' },
            });
            if (current?.run_id !== r.run_id) accepted = false;
          }
          const incidents = await tx.ledgerIncident.findMany({
            where: { domain_id: event.domainId, state: { not: 'resolved' } },
          });
          if (
            incidents.some(
              (i) =>
                (i.amount as { data?: { category?: string } } | null)?.data?.category !==
                'operator_quarantine',
            )
          )
            accepted = false;
          if (!accepted)
            reason =
              'Latest complete custody evidence, shortage/deficit clearance and incident review are required';
          if (accepted)
            for (const i of incidents)
              await tx.ledgerIncident.update({ where: { id: i.id }, data: { state: 'resolved' } });
          await enqueue(
            tx,
            QUEUES.wallet,
            exchangeEventSchema.parse({
              ...event,
              eventId: randomUUID(),
              type: 'operations.domain.resume.responded.v1',
              causationId: event.eventId,
              data: { commandId: event.data.commandId, accepted, reason },
            }),
            `operations-domain-resume-result:${event.data.commandId}`,
          );
        }),
      );
      return;
    }
    if (event.type === 'operations.repair.requested.v1') {
      // Reservation reconciliation never releases a hold from a timeout or missing Wallet row.
      await this.reservations.reconcile(event.domainId);
      const replay = await this.db.outbox.findMany({
        where: {
          published_at: { lt: new Date(Date.now() - 300000) },
          payload: { path: ['domainId'], equals: event.domainId },
          AND: [
            { payload: { path: ['resetEpoch'], equals: event.resetEpoch } },
            {
              OR: [
                'deposit.credited.v1',
                'deposit.reversed.v1',
                'customer-wallet.registry.acknowledged.v1',
                'customer.registry.acknowledged.v1',
                'withdrawal.reserved.v1',
                'settlement.committed.v1',
                'settlement.reversed.v1',
              ].map((type) => ({ payload: { path: ['type'], equals: type } })),
            },
          ],
        },
        orderBy: { published_at: 'asc' },
        take: 100,
      });
      await this.db.outbox.updateMany({
        where: { id: { in: replay.map((r) => r.id) } },
        data: { published_at: null, available_at: new Date() },
      });
      const held = await this.db.withdrawalReservation.findMany({
        where: {
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
          state: { in: ['held', 'frozen'] },
        },
      });
      const incidents = await this.db.ledgerIncident.count({
        where: { domain_id: event.domainId, state: { not: 'resolved' } },
      });
      const oldest = held.length
        ? Math.max(...held.map((r) => Date.now() - r.created_at.getTime()))
        : 0;
      await this.db.$transaction((tx) =>
        enqueue(
          tx,
          QUEUES.wallet,
          exchangeEventSchema.parse({
            ...event,
            eventId: randomUUID(),
            causationId: event.eventId,
            type: 'operations.metrics.reported.v1',
            data: {
              commandId: event.data.commandId,
              consumer: 'ledger',
              metrics: [
                { name: 'held_reservations', value: String(held.length), labels: {} },
                {
                  name: 'oldest_reservation_age_ms',
                  value: String(Math.max(0, oldest)),
                  labels: {},
                  ...(oldest > 300000
                    ? {
                        alert: 'warning',
                        reason:
                          'Old customer holds require reconciliation; never release from age alone',
                      }
                    : {}),
                },
                {
                  name: 'ledger_open_incidents',
                  value: String(incidents),
                  labels: {},
                  ...(incidents
                    ? { alert: 'critical', reason: 'Unresolved Ledger custody incidents' }
                    : {}),
                },
              ],
            },
          }),
          `operations-ledger-metrics:${event.eventId}`,
        ),
      );
      return;
    }
    if (event.type !== 'operations.custody.observed.v1')
      throw new ActionRejectedError('Unsupported operations reconciliation');
    const saved = await this.db.custodyReconciliation.findUnique({
      where: { run_id: event.data.runId },
    });
    if (saved) {
      if (
        saved.domain_id !== event.domainId ||
        saved.reset_epoch !== event.resetEpoch ||
        saved.digest !== exchangeDigest(event.data)
      )
        throw new ActionRejectedError('Reconciliation run replay conflicts with evidence');
      await this.db.outbox.updateMany({
        where: { dedupe_key: `custody-reconciliation:${event.data.runId}` },
        data: { published_at: null, available_at: new Date() },
      });
      return;
    }
    await this.db.$transaction(async (tx) =>
      consumeExchangeEvent(tx, event, async () => {
        const wallet = await tx.exchangeWallet.findUnique({
          where: { wallet_id: event.data.walletId },
        });
        if (!wallet) throw new Error('Custody registration must arrive before reconciliation');
        if (
          wallet.domain_id !== event.domainId ||
          wallet.reset_epoch !== event.resetEpoch ||
          wallet.registry_revision !== event.data.registryRevision ||
          wallet.address_key !==
            (wallet.chain === 'ethereum' ? event.data.address.toLowerCase() : event.data.address) ||
          wallet.role !== (event.data.role === 'customer_deposit' ? 'customer' : event.data.role)
        )
          throw new ActionRejectedError('Custody sample registry mismatch');
        const keys = event.data.observations.map((o) => canonical(o.asset));
        if (new Set(keys).size !== keys.length)
          throw new ActionRejectedError('Duplicate custody sample asset');
        if (
          event.data.observations.some(
            (o) => o.asset.chain !== wallet.chain || o.asset.network !== wallet.network,
          )
        )
          throw new ActionRejectedError('Custody sample network mismatch');
        const prior = await tx.custodyReconciliation.findUnique({
          where: { run_id: event.data.runId },
        });
        if (prior) {
          if (prior.digest !== exchangeDigest(event.data))
            throw new ActionRejectedError('Reconciliation run identity changed');
          return;
        }
        const balances = await tx.$queryRaw<
          Balance[]
        >`SELECT a.type::text,a.owner_id,a.chain,a.network,a.asset_id,a.normal_side::text,COALESCE(e.balance_after,0)::numeric(96,0)::text AS balance,COALESCE(e.sequence,0)::text AS sequence FROM ledger_accounts a LEFT JOIN LATERAL (SELECT balance_after,sequence FROM ledger_entries WHERE account_id=a.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE a.domain_id=${event.domainId} AND a.owner_id=${wallet.wallet_id}`;
        const totals = await tx.$queryRaw<
          Balance[]
        >`SELECT a.type::text,''::text AS owner_id,a.chain,a.network,a.asset_id,a.normal_side::text,SUM(COALESCE(e.balance_after,0))::numeric(96,0)::text AS balance,MAX(COALESCE(e.sequence,0))::text AS sequence FROM ledger_accounts a LEFT JOIN LATERAL (SELECT balance_after,sequence FROM ledger_entries WHERE account_id=a.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE a.domain_id=${event.domainId} GROUP BY a.type,a.chain,a.network,a.asset_id,a.normal_side`;
        const inFlight = await tx.exchangeOperation.count({
          where: {
            domain_id: event.domainId,
            reset_epoch: event.resetEpoch,
            settlement_batch_id: null,
            state: { not: 'reverted' },
            OR: [
              { payload: { path: ['data', 'sourceWalletId'], equals: wallet.wallet_id } },
              { payload: { path: ['data', 'destinationWalletId'], equals: wallet.wallet_id } },
              {
                payload: {
                  path: ['data', 'tokenCosts', 'feePayerWalletId'],
                  equals: wallet.wallet_id,
                },
              },
            ],
          },
        });
        const assetKeys = new Map(event.data.observations.map((o) => [canonical(o.asset), o]));
        for (const a of balances.filter(
          (a) =>
            a.owner_id === wallet.wallet_id &&
            ['custody_hot', 'custody_management', 'custody_deposit', 'custody_rent'].includes(
              a.type,
            ),
        )) {
          const asset = {
            chain: a.chain,
            network: a.network,
            assetId: a.asset_id,
          } as CanonicalAsset;
          if (!assetKeys.has(canonical(asset)))
            assetKeys.set(canonical(asset), {
              asset,
              state: 'unavailable',
              reason: 'Journal asset is missing from the chain sample',
            });
        }
        const rows = [...assetKeys.values()].map((o) => {
          const book = balances
            .filter(
              (a) =>
                a.owner_id === wallet.wallet_id &&
                a.chain === o.asset.chain &&
                a.network === o.asset.network &&
                a.asset_id === o.asset.assetId &&
                ['custody_hot', 'custody_management', 'custody_deposit', 'custody_rent'].includes(
                  a.type,
                ),
            )
            .reduce((n, a) => n + BigInt(a.balance), 0n);
          const observed =
              o.state === 'observed' ? BigInt(o.units!) + BigInt(o.rentUnits ?? '0') : undefined,
            difference = observed === undefined ? undefined : observed - book;
          return {
            asset: o.asset,
            status:
              observed === undefined
                ? ('unavailable' as const)
                : difference === 0n
                  ? ('matched' as const)
                  : ('difference' as const),
            book: book.toString(),
            ...(observed === undefined
              ? {}
              : { observed: observed.toString(), difference: difference!.toString() }),
            inFlight,
            reason:
              observed === undefined
                ? (o.reason ?? 'Canonical RPC evidence unavailable')
                : difference === 0n
                  ? 'Canonical custody matches journal'
                  : inFlight
                    ? 'Custody difference with in-flight execution; pending financial projection is possible'
                    : 'Unexplained custody change, missing deposit posting or external funding; operator review required',
          };
        });
        const report = {
          wallets: rows,
          totals: reconcileAccounting(totals),
          journalWatermark: String(
            await tx.journalBatch.count({ where: { domain_id: event.domainId } }),
          ),
          openIncidents: await tx.ledgerIncident.count({
            where: { domain_id: event.domainId, state: { not: 'resolved' } },
          }),
        };
        const status = rows.some((r) => r.status === 'difference')
          ? 'difference'
          : rows.some((r) => r.status === 'unavailable')
            ? 'unavailable'
            : 'matched';
        await tx.custodyReconciliation.create({
          data: {
            run_id: event.data.runId,
            domain_id: event.domainId,
            reset_epoch: event.resetEpoch,
            wallet_id: wallet.wallet_id,
            digest: exchangeDigest(event.data),
            evidence: event as Prisma.InputJsonValue,
            report: report as unknown as Prisma.InputJsonValue,
          },
        });
        await enqueue(
          tx,
          QUEUES.wallet,
          exchangeEventSchema.parse({
            ...event,
            eventId: randomUUID(),
            causationId: event.eventId,
            type: 'operations.custody.reconciled.v1',
            data: { runId: event.data.runId, walletId: wallet.wallet_id, status, report },
          }),
          `custody-reconciliation:${event.data.runId}`,
        );
      }),
    );
  }
}
