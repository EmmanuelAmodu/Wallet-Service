import { Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/ledger-client';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import { JournalService, JournalPosting } from '../journal/journal.service.js';
import { ExchangeEvent } from '../../../../packages/queue/src/exchange-contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { canonical } from '../../../../packages/queue/src/messages.js';
import { consumeExchangeEvent, publishExchangeEvent } from '../exchange/exchange-inbox.js';
import { AccountSpec } from '../accounts/accounts.service.js';
type IncidentEvent = Extract<
  ExchangeEvent,
  { type: 'custody.loss.detected.v1' | 'custody.loss.reverted.v1' | 'custody.incident.opened.v1' }
>;
type IncidentEvidence = {
  data: IncidentEvent['data'];
  revision: number;
  type: string;
  batchId: string | null;
};

@Injectable()
export class IncidentsService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly journal: JournalService,
  ) {}

  async handle(event: IncidentEvent) {
    await this.db.$transaction(async (tx) =>
      consumeExchangeEvent(tx, event, async () => {
        const previous = await tx.ledgerIncident.findUnique({
          where: { id: event.data.incidentId },
        });
        const evidence = previous?.amount as IncidentEvidence | null;
        if (previous) {
          if (
            previous.domain_id !== event.domainId ||
            previous.customer_id !== (event.customerId ?? null) ||
            !evidence
          )
            throw new ActionRejectedError('Custody incident identity changed');
          const identity = (data: IncidentEvent['data']) =>
            'walletId' in data
              ? {
                  walletId: data.walletId,
                  asset: data.asset,
                  amount: data.amount,
                  transactionHash: data.transactionHash,
                }
              : data;
          if (canonical(identity(evidence!.data)) !== canonical(identity(event.data)))
            throw new ActionRejectedError('Custody incident evidence changed');
          if (event.revision <= evidence!.revision) {
            if (
              event.revision === evidence!.revision &&
              (event.type !== evidence!.type || canonical(event.data) !== canonical(evidence!.data))
            )
              throw new ActionRejectedError('Custody incident revision changed');
            return;
          }
          if (event.type === evidence!.type) {
            await tx.ledgerIncident.update({
              where: { id: previous.id },
              data: {
                amount: {
                  ...evidence!,
                  revision: event.revision,
                  data: event.data,
                } as Prisma.InputJsonValue,
              },
            });
            return;
          }
        }
        const reversalFirst = event.type === 'custody.loss.reverted.v1' && !evidence;
        const customer = event.customerId
          ? await tx.exchangeCustomer.findUnique({ where: { customer_id: event.customerId } })
          : null;
        if (event.customerId && !customer)
          throw new Error('Custody incident customer registry has not arrived');
        if (customer && customer.domain_id !== event.domainId)
          throw new ActionRejectedError('Incident customer domain mismatch');
        const freeze =
          event.type === 'custody.loss.detected.v1' ||
          reversalFirst ||
          (event.type === 'custody.incident.opened.v1' &&
            ['high', 'critical'].includes(event.data.severity));
        const postings: JournalPosting[] = [];
        if (event.type !== 'custody.incident.opened.v1') {
          const wallet = await tx.exchangeWallet.findUnique({
            where: { wallet_id: event.data.walletId },
          });
          if (!wallet) throw new Error('Custody loss wallet registry has not arrived');
          const { asset } = event.data;
          if (
            !wallet ||
            wallet.role !== 'customer' ||
            wallet.customer_id !== event.customerId ||
            wallet.domain_id !== event.domainId ||
            wallet.reset_epoch !== event.resetEpoch ||
            wallet.chain !== asset.chain ||
            wallet.network !== asset.network
          )
            throw new ActionRejectedError('Custody loss wallet identity mismatch');
          const spec = (
            type: AccountSpec['type'],
            ownerKind: AccountSpec['ownerKind'],
            ownerId: string,
          ): AccountSpec => ({
            domainId: event.domainId,
            ...asset,
            type,
            ownerKind,
            ownerId,
            normalSide: 'debit',
          });
          const reverted = event.type === 'custody.loss.reverted.v1';
          if (!reversalFirst)
            postings.push(
              {
                account: spec('reconciliation', 'exchange', event.domainId),
                side: reverted ? 'credit' : 'debit',
                amount: BigInt(event.data.amount),
              },
              {
                account: spec('custody_deposit', 'wallet', wallet.wallet_id),
                side: reverted ? 'debit' : 'credit',
                amount: BigInt(event.data.amount),
              },
            );
        }
        if (freeze && customer) {
          await tx.exchangeCustomer.update({
            where: { customer_id: customer.customer_id },
            data: { state: 'frozen' },
          });
          const available = await tx.ledgerAccount.findMany({
            where: {
              domain_id: event.domainId,
              owner_kind: 'customer',
              owner_id: customer.customer_id,
              type: 'customer_available',
            },
            orderBy: { account_key: 'asc' },
          });
          for (const account of available) {
            const spec: AccountSpec = {
              domainId: event.domainId,
              chain: account.chain,
              network: account.network,
              assetId: account.asset_id,
              type: 'customer_available',
              ownerKind: 'customer',
              ownerId: customer.customer_id,
              normalSide: 'credit',
            };
            const amount = await this.journal.balance(tx, spec);
            if (amount > 0n)
              postings.push(
                { account: spec, side: 'debit', amount },
                { account: { ...spec, type: 'customer_frozen' }, side: 'credit', amount },
              );
          }
        }
        const batch = postings.length
          ? await this.journal.post(tx, {
              key: `custody-incident:${event.data.incidentId}:${event.revision}`,
              domainId: event.domainId,
              revision: event.revision,
              kind: reversalFirst
                ? 'custody.incident.freeze'
                : event.type === 'custody.loss.reverted.v1'
                  ? 'custody.loss.reversal'
                  : 'custody.loss',
              postings,
              ...(event.type === 'custody.loss.reverted.v1' && !reversalFirst
                ? { reversalOfBatchId: evidence!.batchId! }
                : {}),
            })
          : null;
        const amount = {
          data: event.data,
          revision: event.revision,
          type: event.type,
          batchId: reversalFirst ? null : (batch?.id ?? null),
        } as Prisma.InputJsonValue;
        const patch = {
          reason: event.data.reason,
          amount,
          state: event.type === 'custody.loss.reverted.v1' ? 'reverted' : 'open',
        };
        await tx.ledgerIncident.upsert({
          where: { id: event.data.incidentId },
          create: {
            id: event.data.incidentId,
            domain_id: event.domainId,
            customer_id: event.customerId,
            ...patch,
          },
          update: patch,
        });
        if (event.type === 'custody.loss.detected.v1')
          await publishExchangeEvent(
            tx,
            event,
            {
              type: 'custody.loss.recorded.v1',
              data: {
                incidentId: event.data.incidentId,
                ledgerBatchId: batch!.id,
                walletId: event.data.walletId,
                asset: event.data.asset,
                amount: event.data.amount,
                transactionHash: event.data.transactionHash,
              },
            },
            `custody-loss-recorded:${event.data.incidentId}:${event.revision}`,
          );
        else
          await publishExchangeEvent(
            tx,
            event,
            { type: event.type, data: event.data },
            `custody-incident-recorded:${event.data.incidentId}:${event.revision}`,
          );
      }),
    );
  }
}
