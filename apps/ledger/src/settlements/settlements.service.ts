import { Injectable } from '@nestjs/common';
import type { ExchangeOperation, ExchangeWallet, Prisma } from '.prisma/ledger-client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { tokenAsset } from '../../../../packages/shared/src/token-contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  canonicalTransactionHash,
  chainFamily,
} from '../../../../packages/shared/src/contracts.js';
import { AccountSpec, accountNormalSides } from '../accounts/accounts.service.js';
import { JournalPosting, JournalService } from '../journal/journal.service.js';
import { LedgerPrismaService } from '../prisma/prisma.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import {
  consumeExchangeEvent,
  exchangeDigest,
  publishExchangeEvent,
} from '../exchange/exchange-inbox.js';
import { resultIdentity } from '../exchange/events.js';
import {
  PayoutBatchLedgerCommand,
  payoutBatchLedgerCommandSchema,
  validateBitcoinBatch,
} from '../../../../packages/shared/src/bitcoin-batch-contracts.js';
import {
  payoutBatchManifestSchema,
  allocateBatchCosts,
} from '../../../../packages/shared/src/payout-policy.js';
import { executionDigest } from '../../../../packages/shared/src/execution-authorization.js';

type ExecuteEvent = Extract<
  ExchangeEvent,
  {
    type:
      | 'sweep.execute.requested.v1'
      | 'funding.execute.requested.v1'
      | 'withdrawal.execute.requested.v1';
  }
>;
type SettlementEvent = Extract<ExchangeEvent, { type: 'settlement.requested.v1' }>;
type RevertEvent = Extract<ExchangeEvent, { type: 'settlement.reverted.v1' }>;

function assetKey(asset: CanonicalAsset) {
  return canonical([asset.chain, asset.network, asset.assetId]);
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly db: LedgerPrismaService,
    private readonly journal: JournalService,
    private readonly reservations: ReservationsService,
  ) {}

  /** One transaction owns every original hold and journal in the atomic chain payout. */
  async handleBatch(input: PayoutBatchLedgerCommand) {
    const command = payoutBatchLedgerCommandSchema.parse(input);
    return this.db.$transaction(
      async (tx) => {
        await lock(tx, `exchange-domain:${command.domainId}`);
        await lock(tx, `payout-batch:${command.batchId}`);
        let batch = await tx.ledgerPayoutBatch.findUnique({ where: { id: command.batchId } });
        if (
          batch &&
          (batch.domain_id !== command.domainId || batch.reset_epoch !== command.resetEpoch)
        )
          throw new ActionRejectedError('Payout batch scope mismatch');
        await tx.$executeRaw`SELECT set_config('waas.payout_batch', ${command.batchId}, true)`;
        if (command.type === 'payout.batch.ledger.prepare') {
          const { manifest, preparation } = validateBitcoinBatch(
            command.manifest,
            command.preparation,
          );
          if (
            manifest.batchId !== command.batchId ||
            manifest.domainId !== command.domainId ||
            manifest.resetEpoch !== command.resetEpoch
          )
            throw new ActionRejectedError('Payout batch approval scope mismatch');
          if (batch) {
            if (
              batch.manifest_digest !== preparation.manifestDigest ||
              batch.preparation_digest !== preparation.preparationDigest
            )
              throw new ActionRejectedError('Payout batch approval is immutable');
          } else {
            const expiry = Date.parse(preparation.expiresAt);
            if (expiry <= Date.now() || expiry > Date.now() + 300_000)
              throw new ActionRejectedError(
                'Payout batch preparation expired or outside approval window',
              );
            const source = await this.wallet(tx, manifest.sourceWalletId, command, manifest.asset);
            if (
              source.role !== 'hot' ||
              source.account !== 0 ||
              source.address !== manifest.sourceAddress ||
              source.registry_revision !== manifest.sourceRegistryRevision
            )
              throw new ActionRejectedError(
                'Payout batch requires its exact acknowledged hot source',
              );
            batch = await tx.ledgerPayoutBatch.create({
              data: {
                id: command.batchId,
                domain_id: command.domainId,
                reset_epoch: command.resetEpoch,
                manifest: manifest as Prisma.InputJsonValue,
                manifest_digest: preparation.manifestDigest,
                preparation: preparation as unknown as Prisma.InputJsonValue,
                preparation_digest: preparation.preparationDigest,
              },
            });
            for (const [index, member] of manifest.members.entries()) {
              if (await tx.exchangeOperation.findUnique({ where: { id: member.operationId } }))
                throw new ActionRejectedError(
                  'Previously attempted obligation cannot enter a payout batch',
                );
              const hold = await tx.withdrawalReservation.findUniqueOrThrow({
                where: { id: member.reservationId },
              });
              if (
                hold.operation_id !== member.operationId ||
                hold.customer_id !== member.customerId ||
                hold.request_digest !== member.requestDigest ||
                hold.state !== 'held'
              )
                throw new ActionRejectedError(
                  'Batch member requires its exact original active hold',
                );
              await this.recordExecution(
                tx,
                this.batchMemberEvent(manifest, index, 'withdrawal.execute.requested.v1', 1, {
                  sourceWalletId: manifest.sourceWalletId,
                  destination: member.destination,
                  amount: { asset: manifest.asset, amount: member.principalUnits },
                  preparationDigest: preparation.preparationDigest,
                }) as ExecuteEvent,
              );
              await tx.ledgerPayoutBatchMember.create({
                data: {
                  batch_id: batch.id,
                  member_index: index,
                  operation_id: member.operationId,
                  attempt_id: member.attemptId,
                  reservation_id: member.reservationId,
                },
              });
            }
          }
        } else {
          if (!batch) throw new Error('Payout batch approval has not arrived');
          const { manifest, preparation } = validateBitcoinBatch(batch.manifest, batch.preparation);
          const receipt = await tx.ledgerPayoutBatchReceipt.findUnique({
            where: { batch_id_revision: { batch_id: batch.id, revision: command.revision } },
          });
          const digest = executionDigest(command);
          if (receipt) {
            if (receipt.digest !== digest)
              throw new ActionRejectedError('Payout batch revision has conflicting content');
          } else {
            if (command.type === 'payout.batch.ledger.settle') {
              if (command.actualFeeUnits !== preparation.feeUnits)
                throw new ActionRejectedError(
                  'Canonical batch fee differs from its exact prepared inputs and outputs',
                );
              const identity = canonical([
                batch.domain_id,
                'bitcoin',
                'regtest',
                command.transactionHash,
              ]);
              if (batch.chain_identity && batch.chain_identity !== identity)
                throw new ActionRejectedError('Payout batch transaction identity is immutable');
              if (batch.state === 'settled' && command.revision > batch.revision)
                throw new ActionRejectedError(
                  'A new batch settlement revision requires canonical reversal first',
                );
              if (
                await tx.exchangeOperation.findUnique({ where: { settlement_identity: identity } })
              )
                throw new ActionRejectedError(
                  'Payout transaction already belongs to an individual obligation',
                );
              batch = await tx.ledgerPayoutBatch.update({
                where: { id: batch.id },
                data: { chain_identity: identity },
              });
              const shares = allocateBatchCosts(manifest, command.actualFeeUnits);
              for (const [index, share] of shares.entries())
                await this.settle(
                  tx,
                  this.batchMemberEvent(
                    manifest,
                    index,
                    'settlement.requested.v1',
                    command.revision,
                    {
                      transactionHash: command.transactionHash,
                      outcome: 'confirmed',
                      actualFees:
                        share.feeUnits === '0'
                          ? []
                          : [{ asset: manifest.asset, amount: share.feeUnits }],
                    },
                  ) as SettlementEvent,
                  batch.id,
                );
            } else {
              if (command.revision <= command.priorSettlementRevision)
                throw new ActionRejectedError(
                  'Batch reversal must follow its referenced settlement',
                );
              if (
                batch.state === 'settled' &&
                command.revision > batch.revision &&
                command.priorSettlementRevision !== batch.revision
              )
                throw new ActionRejectedError(
                  'Batch reversal must identify the current canonical settlement',
                );
              for (const [index] of manifest.members.entries())
                await this.revert(
                  tx,
                  this.batchMemberEvent(
                    manifest,
                    index,
                    'settlement.reverted.v1',
                    command.revision,
                    {
                      priorSettlementRevision: command.priorSettlementRevision,
                      reason: command.reason,
                    },
                  ) as RevertEvent,
                  batch.id,
                );
            }
            await tx.ledgerPayoutBatchReceipt.create({
              data: {
                batch_id: batch.id,
                revision: command.revision,
                digest,
                payload: command as Prisma.InputJsonValue,
              },
            });
            if (command.revision > batch.revision)
              batch = await tx.ledgerPayoutBatch.update({
                where: { id: batch.id },
                data: {
                  revision: command.revision,
                  state: command.type === 'payout.batch.ledger.settle' ? 'settled' : 'reverted',
                },
              });
          }
        }
        await enqueue(
          tx,
          QUEUES.wallet,
          {
            type: 'payout.batch.ledger.result',
            batchId: batch!.id,
            domainId: batch!.domain_id,
            resetEpoch: batch!.reset_epoch,
            manifestDigest: batch!.manifest_digest,
            preparationDigest: batch!.preparation_digest,
            state: batch!.state as 'prepared' | 'settled' | 'reverted',
            revision: batch!.revision,
          },
          `payout-batch-ledger:${batch!.id}:${batch!.revision}`,
        );
        return batch!;
      },
      { timeout: 30_000 },
    );
  }

  private batchMemberEvent(
    manifest: ReturnType<typeof payoutBatchManifestSchema.parse>,
    index: number,
    type: ExecuteEvent['type'] | SettlementEvent['type'] | RevertEvent['type'],
    revision: number,
    data: unknown,
  ) {
    const member = manifest.members[index];
    const digest = executionDigest([manifest.batchId, member.operationId, type, revision]);
    const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return exchangeEventSchema.parse({
      eventId,
      schemaVersion: 1,
      domainId: manifest.domainId,
      resetEpoch: manifest.resetEpoch,
      occurredAt: new Date().toISOString(),
      correlationId: manifest.batchId,
      causationId: null,
      aggregateId: member.operationId,
      revision,
      type,
      operationId: member.operationId,
      attemptId: member.attemptId,
      customerId: member.customerId,
      requestDigest: member.requestDigest,
      policyVersion: 'exchange-financial-v1',
      data,
    });
  }

  private async requireBatchContext(
    tx: Prisma.TransactionClient,
    operationId: string,
    batchId?: string,
  ) {
    const member = await tx.ledgerPayoutBatchMember.findUnique({
      where: { operation_id: operationId },
    });
    if (member?.batch_id !== batchId)
      throw new ActionRejectedError(
        'Batch members require atomic complete batch financial processing',
      );
  }

  async handle(event: ExchangeEvent) {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `exchange-domain:${event.domainId}`);
      await consumeExchangeEvent(tx, event, async () => {
        if (
          event.type === 'sweep.execute.requested.v1' ||
          event.type === 'funding.execute.requested.v1' ||
          event.type === 'withdrawal.execute.requested.v1'
        )
          await this.recordExecution(tx, event);
        else if (event.type === 'execution.attempt.updated.v1') await this.updateAttempt(tx, event);
        else if (event.type === 'settlement.requested.v1') await this.settle(tx, event);
        else if (event.type === 'settlement.reverted.v1') await this.revert(tx, event);
        else throw new ActionRejectedError('Unsupported settlement event');
      });
    });
  }

  private account(
    domainId: string,
    asset: CanonicalAsset,
    type: AccountSpec['type'],
    ownerId: string,
  ): AccountSpec {
    return {
      domainId,
      ...asset,
      type,
      ownerId,
      ownerKind:
        type.startsWith('customer_') || type === 'deficit'
          ? 'customer'
          : type.startsWith('custody_')
            ? 'wallet'
            : 'exchange',
      normalSide: accountNormalSides[type],
    };
  }

  private custody(domainId: string, asset: CanonicalAsset, wallet: ExchangeWallet) {
    const type =
      wallet.role === 'hot'
        ? 'custody_hot'
        : wallet.role === 'management'
          ? 'custody_management'
          : 'custody_deposit';
    return this.account(domainId, asset, type, wallet.wallet_id);
  }

  private async wallet(
    tx: Prisma.TransactionClient,
    id: string,
    event: Pick<ExchangeEvent, 'domainId' | 'resetEpoch'>,
    asset: CanonicalAsset,
  ) {
    const wallet = await tx.exchangeWallet.findUnique({ where: { wallet_id: id } });
    if (
      !wallet ||
      wallet.domain_id !== event.domainId ||
      wallet.reset_epoch !== event.resetEpoch ||
      wallet.chain !== asset.chain ||
      wallet.network !== asset.network
    )
      throw new ActionRejectedError(
        'Execution wallet does not match custody domain, epoch and asset network',
      );
    return wallet;
  }

  private async recordExecution(tx: Prisma.TransactionClient, event: ExecuteEvent) {
    const reversals = await this.reversals(tx, event);
    const existing = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (existing) {
      const original = exchangeEventSchema.parse(existing.payload) as ExecuteEvent;
      if (
        existing.domain_id !== event.domainId ||
        existing.reset_epoch !== event.resetEpoch ||
        existing.request_digest !== event.requestDigest ||
        existing.attempt_id !== event.attemptId ||
        canonical(original.data) !== canonical(event.data) ||
        original.customerId !== event.customerId
      )
        throw new ActionRejectedError(
          'Execution operation identity and approved request are immutable',
        );
      await this.acknowledgeExecution(tx, event);
      return;
    }
    const source = await this.wallet(tx, event.data.sourceWalletId, event, event.data.amount.asset);
    let reservationId: string | undefined;
    let customerId = event.customerId;
    if (event.type === 'withdrawal.execute.requested.v1') {
      if (source.role !== 'hot')
        throw new ActionRejectedError('Withdrawals execute only from hot custody');
      const reservation = await tx.withdrawalReservation.findUnique({
        where: { operation_id: event.operationId },
      });
      if (!reservation) throw new Error('Withdrawal reservation has not arrived');
      if (
        reservation.domain_id !== event.domainId ||
        reservation.request_digest !== event.requestDigest ||
        reservation.reset_epoch !== event.resetEpoch ||
        reservation.state !== 'held'
      )
        throw new ActionRejectedError('Withdrawal requires its active immutable reservation');
      const request = exchangeEventSchema.parse(
        (reservation.request as { source?: unknown }).source,
      );
      if (
        request.type !== 'withdrawal.reserve.requested.v1' ||
        request.data.hotWalletId !== source.wallet_id ||
        request.data.destination !== event.data.destination ||
        assetKey(request.data.principal.asset) !== assetKey(event.data.amount.asset) ||
        request.data.principal.amount !== event.data.amount.amount ||
        (event.customerId && event.customerId !== reservation.customer_id)
      )
        throw new ActionRejectedError(
          'Withdrawal execution differs from the accepted principal, destination or hot wallet',
        );
      const customer = await tx.exchangeCustomer.findUniqueOrThrow({
        where: { customer_id: reservation.customer_id },
      });
      if (customer.state !== 'active')
        throw new ActionRejectedError('Frozen customer cannot start execution');
      const ownDestination = await tx.exchangeWallet.findFirst({
        where: {
          domain_id: event.domainId,
          chain: source.chain,
          network: source.network,
          address_key:
            chainFamily(request.data.principal.asset.chain) === 'ethereum'
              ? event.data.destination.toLowerCase()
              : event.data.destination,
        },
      });
      if (ownDestination)
        throw new ActionRejectedError(
          'Exchange-owned withdrawal destinations require an internal transfer flow',
        );
      reservationId = reservation.id;
      customerId = reservation.customer_id;
    } else {
      const destination = await this.wallet(
        tx,
        event.data.destinationWalletId,
        event,
        event.data.amount.asset,
      );
      if (
        event.type === 'sweep.execute.requested.v1' &&
        (source.role !== 'customer' ||
          destination.role !== 'hot' ||
          source.hot_wallet_id !== destination.wallet_id)
      )
        throw new ActionRejectedError(
          'Sweep must move customer custody to its registered hot wallet',
        );
      if (
        event.type === 'funding.execute.requested.v1' &&
        (source.role !== 'management' ||
          source.account !== 1 ||
          destination.role !== 'customer' ||
          (event.customerId && destination.customer_id !== event.customerId) ||
          event.data.amount.asset.assetId !== `token:${source.chain}:native` ||
          !['ethereum', 'solana'].includes(source.chain) ||
          BigInt(event.data.amount.amount) >
            (source.chain === 'ethereum' ? 5_000_000_000_000_000n : 10_000_000n))
      )
        throw new ActionRejectedError(
          'Funding must move management custody to registered customer custody',
        );
    }
    await this.costAuthority(tx, event, source);
    if (reversals.some((row) => row.customer_id && row.customer_id !== customerId))
      throw new ActionRejectedError('Reversed execution customer identity is immutable');
    await tx.exchangeOperation.create({
      data: {
        id: event.operationId,
        domain_id: event.domainId,
        customer_id: customerId,
        reservation_id: reservationId,
        request_digest: event.requestDigest,
        kind:
          event.type === 'withdrawal.execute.requested.v1'
            ? 'withdrawal'
            : event.type === 'sweep.execute.requested.v1'
              ? 'sweep'
              : 'funding',
        payload: event as Prisma.InputJsonValue,
        attempt_id: event.attemptId,
        attempt_revision: 0,
        state: reversals.length ? 'reverted' : 'preparing',
        settlement_revision: reversals.reduce(
          (revision, row) => Math.max(revision, row.revision),
          0,
        ),
        reset_epoch: event.resetEpoch,
      },
    });
    await this.acknowledgeExecution(tx, event);
  }

  private async acknowledgeExecution(tx: Prisma.TransactionClient, event: ExecuteEvent) {
    if (
      event.type !== 'funding.execute.requested.v1' &&
      !('tokenCosts' in event.data && event.data.tokenCosts)
    )
      return;
    await enqueue(
      tx,
      QUEUES.wallet,
      exchangeEventSchema.parse({
        ...resultIdentity(event),
        type: 'execution.registry.acknowledged.v1',
        operationId: event.operationId,
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        data: { consumer: 'ledger' },
      }),
      `execution-registry:${event.operationId}:ledger`,
    );
  }

  private async costAuthority(
    tx: Prisma.TransactionClient,
    execution: ExecuteEvent,
    source: ExchangeWallet,
    checkRevision = true,
  ) {
    if (execution.type === 'funding.execute.requested.v1') return { payer: source };
    if (!execution.data.tokenCosts) {
      if (execution.data.amount.asset.assetId !== `token:${source.chain}:native`)
        throw new ActionRejectedError('Token execution requires a certified fee and rent binding');
      return { payer: source };
    }
    const costs = execution.data.tokenCosts;
    if (
      BigInt(costs.maximumFeeUnits) >
        (costs.certificate.standard === 'erc20' ? 5_000_000_000_000_000n : 100_000n) ||
      BigInt(costs.maximumRentUnits) > (costs.certificate.standard === 'erc20' ? 0n : 10_000_000n)
    )
      throw new ActionRejectedError('Token cost authorization exceeds fee/rent policy');
    if (assetKey(tokenAsset(costs.certificate)) !== assetKey(execution.data.amount.asset))
      throw new ActionRejectedError('Token cost certificate does not match principal');
    const payer = await this.wallet(
      tx,
      costs.feePayerWalletId,
      execution,
      execution.data.amount.asset,
    );
    if (checkRevision && payer.registry_revision !== costs.feePayerRegistryRevision)
      throw new ActionRejectedError('Token fee payer registry revision changed');
    if (costs.certificate.standard === 'erc20') {
      if (
        payer.wallet_id !== source.wallet_id ||
        costs.maximumRentUnits !== '0' ||
        costs.rentCustodyWalletId
      )
        throw new ActionRejectedError('ERC-20 fees must use the source; rent is unsupported');
    } else if (execution.type === 'sweep.execute.requested.v1') {
      if (
        source.role !== 'customer' ||
        payer.role !== 'management' ||
        payer.account !== 1 ||
        costs.rentCustodyWalletId !== execution.data.destinationWalletId
      )
        throw new ActionRejectedError('SPL sweep requires management1 fees and hot-owned rent');
      const hot = await this.wallet(
        tx,
        costs.rentCustodyWalletId,
        execution,
        execution.data.amount.asset,
      );
      if (hot.role !== 'hot' || hot.account !== 0 || source.hot_wallet_id !== hot.wallet_id)
        throw new ActionRejectedError('SPL rent beneficiary must be the registered hot wallet');
    } else if (
      payer.wallet_id !== source.wallet_id ||
      source.role !== 'hot' ||
      costs.rentCustodyWalletId
    ) {
      throw new ActionRejectedError(
        'SPL withdrawal pays from hot custody; external rent is expense',
      );
    }
    return { payer };
  }

  private async reversals(
    tx: Prisma.TransactionClient,
    event: ExchangeEvent & { operationId: string; attemptId: string; requestDigest: string },
  ) {
    const rows = await tx.settlementReversal.findMany({
      where: { operation_id: event.operationId },
    });
    for (const row of rows) {
      if (
        row.domain_id !== event.domainId ||
        row.reset_epoch !== event.resetEpoch ||
        row.attempt_id !== event.attemptId ||
        row.request_digest !== event.requestDigest ||
        (row.customer_id && event.customerId && row.customer_id !== event.customerId)
      )
        throw new ActionRejectedError('Reversed execution attempt identity is immutable');
    }
    return rows;
  }

  private async operation(
    tx: Prisma.TransactionClient,
    event: ExchangeEvent & { operationId: string; attemptId: string; requestDigest: string },
  ): Promise<ExchangeOperation> {
    const operation = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (!operation) throw new Error('Execution intent has not arrived; retain and retry the event');
    if (
      operation.domain_id !== event.domainId ||
      operation.reset_epoch !== event.resetEpoch ||
      operation.request_digest !== event.requestDigest ||
      (event.customerId && operation.customer_id !== event.customerId)
    )
      throw new ActionRejectedError('Execution attempt identity mismatch');
    const attempt = await tx.ledgerExecutionAttempt.findUnique({ where: { id: event.attemptId } });
    if (
      !attempt ||
      attempt.operation_id !== operation.id ||
      attempt.domain_id !== event.domainId ||
      attempt.reset_epoch !== event.resetEpoch ||
      attempt.request_digest !== event.requestDigest ||
      attempt.kind !== operation.kind ||
      attempt.reservation_id !== operation.reservation_id ||
      attempt.customer_id !== operation.customer_id
    )
      throw new ActionRejectedError(
        'Attempt has not been independently approved for this obligation',
      );
    // Financial status belongs to the obligation; execution authority belongs to the bound attempt.
    return { ...operation, payload: attempt.intent };
  }

  private async updateAttempt(
    tx: Prisma.TransactionClient,
    event: Extract<ExchangeEvent, { type: 'execution.attempt.updated.v1' }>,
  ) {
    const operation = await this.operation(tx, event);
    const progress = await tx.ledgerAttemptProgress.findUnique({
      where: { attempt_id: event.attemptId },
    });
    if (!progress) throw new Error('Attempt progress is unavailable; retain and retry delivery');
    const digest = exchangeDigest(event.data);
    const received = await tx.ledgerAttemptReport.findUnique({
      where: { attempt_id_revision: { attempt_id: event.attemptId, revision: event.revision } },
    });
    if (received) {
      const original = exchangeEventSchema.parse(received.payload);
      if (
        original.type !== 'execution.attempt.updated.v1' ||
        received.data_digest !== digest ||
        canonical(original.data) !== canonical(event.data)
      )
        throw new ActionRejectedError('Attempt revision conflicts with recorded report content');
      return;
    }
    const record = (disposition: string) =>
      tx.ledgerAttemptReport.create({
        data: {
          attempt_id: event.attemptId,
          revision: event.revision,
          data_digest: digest,
          payload: event as Prisma.InputJsonValue,
          disposition,
        },
      });
    if (event.revision < progress.reported_revision) {
      await record('ignored_stale');
      return;
    }
    if (event.revision === progress.reported_revision) {
      // Older deployments retained a high-water mark, not the complete report body.
      if (
        progress.reported_revision <= 0 ||
        progress.reported_digest !== null ||
        (progress.reported_state !== 'unknown' && progress.reported_state !== event.data.state)
      )
        throw new ActionRejectedError('Attempt revision conflicts with recorded report content');
      await record('projection_replay');
      await tx.ledgerAttemptProgress.update({
        where: { attempt_id: event.attemptId },
        data: { reported_state: event.data.state, reported_digest: digest },
      });
      return;
    }
    const terminal = !!operation.settlement_payload || operation.state === 'reverted';
    if (!terminal && operation.reservation_id) {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id },
      });
      if (!['held', 'frozen'].includes(reservation.state))
        throw new ActionRejectedError('Attempt cannot expose a released reservation');
    }
    const ranks: Record<string, number> = {
      unknown: 0,
      preparing: 0,
      signing: 1,
      signed: 2,
      queued: 3,
      submitted: 4,
      attention: 4,
      confirmed: 5,
      failed: 5,
    };
    const resumingSigned =
      progress.reported_state === 'attention' && ['queued', 'submitted'].includes(event.data.state);
    if (
      !terminal &&
      !resumingSigned &&
      event.data.state !== 'attention' &&
      ranks[event.data.state] < ranks[progress.reported_state]
    )
      throw new ActionRejectedError('Attempt state cannot regress');
    await record(terminal ? 'terminal_observation' : 'applied');
    await tx.ledgerAttemptProgress.update({
      where: { attempt_id: event.attemptId },
      data: {
        reported_state: event.data.state,
        reported_revision: event.revision,
        reported_digest: digest,
      },
    });
    // Report progress must never overwrite canonical payment/reversal or release a hold.
    if (!terminal)
      await tx.exchangeOperation.update({
        where: { id: operation.id },
        data: { state: event.data.state, attempt_revision: event.revision },
      });
  }

  private async settle(tx: Prisma.TransactionClient, event: SettlementEvent, batchId?: string) {
    await this.requireBatchContext(tx, event.operationId, batchId);
    const operation = await this.operation(tx, event);
    await this.retainCanonicalEvent(tx, event);
    const reversals = await this.reversals(tx, event);
    const execution = exchangeEventSchema.parse(operation.payload) as ExecuteEvent;
    const source = await this.wallet(
      tx,
      execution.data.sourceWalletId,
      event,
      execution.data.amount.asset,
    );
    const { payer } = await this.costAuthority(tx, execution, source, false);
    const costs =
      execution.type === 'funding.execute.requested.v1' ? undefined : execution.data.tokenCosts;
    const rent = BigInt(event.data.actualRentUnits ?? '0');
    if (
      rent > 0n &&
      (!costs || costs.certificate.standard !== 'spl' || event.data.outcome !== 'confirmed')
    )
      throw new ActionRejectedError('Rent requires an approved successful SPL account creation');
    const hash = canonicalTransactionHash(
      execution.data.amount.asset.chain,
      event.data.transactionHash,
    );
    const chainIdentity = canonical([event.domainId, source.chain, source.network, hash]);
    if (
      !batchId &&
      (await tx.ledgerPayoutBatch.findUnique({ where: { chain_identity: chainIdentity } }))
    )
      throw new ActionRejectedError('Transaction already belongs to an approved payout batch');
    const identity = batchId
      ? canonical([event.domainId, source.chain, source.network, hash, batchId, event.operationId])
      : chainIdentity;
    const digest = exchangeDigest({
      identity,
      outcome: event.data.outcome,
      actualFees: event.data.actualFees,
      ...(rent > 0n ? { actualRentUnits: rent.toString() } : {}),
    });
    if (operation.settlement_identity && operation.settlement_identity !== identity)
      throw new ActionRejectedError('An immutable attempt cannot settle a different transaction');
    const duplicate = await tx.exchangeOperation.findUnique({
      where: { settlement_identity: identity },
    });
    if (duplicate && duplicate.id !== operation.id)
      throw new ActionRejectedError('Transaction already belongs to another operation');
    for (const reversal of reversals.filter(
      (row) => row.prior_settlement_revision === event.revision,
    )) {
      if (reversal.prior_settlement_digest && reversal.prior_settlement_digest !== digest)
        throw new ActionRejectedError('Reversed settlement revision has conflicting content');
      if (!reversal.prior_settlement_digest)
        await tx.settlementReversal.update({
          where: {
            operation_id_revision: { operation_id: operation.id, revision: reversal.revision },
          },
          data: {
            prior_settlement_digest: digest,
            prior_settlement_payload: event as Prisma.InputJsonValue,
          },
        });
    }
    if (event.revision < operation.settlement_revision) {
      // Bind a late orphaned settlement to its immutable transaction without posting it.
      // This also prevents a later re-inclusion from changing the transaction identity.
      if (!operation.settlement_identity)
        await tx.exchangeOperation.update({
          where: { id: operation.id },
          data: { settlement_identity: identity },
        });
      return;
    }
    if (operation.settlement_batch_id && operation.state !== 'reverted') {
      if (operation.settlement_identity !== identity || operation.settlement_digest !== digest)
        throw new ActionRejectedError(
          'Settled attempt cannot change transaction, outcome or actual fees',
        );
      return;
    }
    if (event.revision <= operation.settlement_revision)
      throw new ActionRejectedError('Canonical settlement requires a new revision after reversal');
    if (event.data.outcome === 'failed' && !event.data.actualFees.length)
      throw new ActionRejectedError(
        'A failed on-chain settlement requires evidence of paid network fees',
      );
    const postings: JournalPosting[] = [];
    if (operation.kind === 'withdrawal') {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id! },
      });
      if (!['held', 'frozen'].includes(reservation.state))
        throw new ActionRejectedError('Settlement requires an outstanding customer obligation');
      const request = exchangeEventSchema.parse(
        (reservation.request as { source?: unknown }).source,
      );
      if (request.type !== 'withdrawal.reserve.requested.v1')
        throw new ActionRejectedError('Invalid accepted withdrawal request');
      if (event.data.outcome === 'confirmed') {
        for (const amount of request.data.amounts)
          postings.push({
            account: this.account(
              event.domainId,
              amount.asset,
              'customer_reserved',
              reservation.customer_id,
            ),
            side: 'debit',
            amount: BigInt(amount.amount),
          });
        postings.push({
          account: this.custody(event.domainId, request.data.principal.asset, source),
          side: 'credit',
          amount: BigInt(request.data.principal.amount),
        });
        if (request.data.customerFee)
          postings.push({
            account: this.account(
              event.domainId,
              request.data.customerFee.asset,
              'fee_revenue',
              event.domainId,
            ),
            side: 'credit',
            amount: BigInt(request.data.customerFee.amount),
          });
      } else postings.push(...(await this.reservations.releasePostings(tx, reservation)));
      await tx.withdrawalReservation.update({
        where: { id: reservation.id },
        data: { state: 'settled' },
      });
    } else if (event.data.outcome === 'confirmed') {
      if (execution.type === 'withdrawal.execute.requested.v1')
        throw new ActionRejectedError('Custody operation identity mismatch');
      const destination = await this.wallet(
        tx,
        execution.data.destinationWalletId,
        event,
        execution.data.amount.asset,
      );
      const amount = BigInt(execution.data.amount.amount);
      postings.push(
        {
          account: this.custody(event.domainId, execution.data.amount.asset, source),
          side: 'credit',
          amount,
        },
        {
          account: this.custody(event.domainId, execution.data.amount.asset, destination),
          side: 'debit',
          amount,
        },
      );
    }
    for (const fee of event.data.actualFees) {
      if (
        fee.asset.chain !== source.chain ||
        fee.asset.network !== source.network ||
        fee.asset.assetId !== `token:${source.chain}:native`
      )
        throw new ActionRejectedError(
          'Actual transaction fee must use the source network native asset',
        );
      postings.push(
        {
          account: this.account(event.domainId, fee.asset, 'fee_expense', event.domainId),
          side: 'debit',
          amount: BigInt(fee.amount),
        },
        {
          account: this.custody(event.domainId, fee.asset, payer),
          side: 'credit',
          amount: BigInt(fee.amount),
        },
      );
    }
    if (rent > 0n) {
      const native: CanonicalAsset = {
        chain: source.chain as CanonicalAsset['chain'],
        network: source.network,
        assetId: `token:${source.chain}:native`,
      };
      postings.push(
        {
          account: costs!.rentCustodyWalletId
            ? this.account(event.domainId, native, 'custody_rent', costs!.rentCustodyWalletId)
            : this.account(event.domainId, native, 'fee_expense', event.domainId),
          side: 'debit',
          amount: rent,
        },
        { account: this.custody(event.domainId, native, payer), side: 'credit', amount: rent },
      );
    }
    const batch = await this.journal.post(tx, {
      key: `settlement:${operation.id}:${event.revision}`,
      domainId: event.domainId,
      operationId: operation.id,
      revision: event.revision,
      kind: 'settlement',
      postings,
    });
    await tx.exchangeOperation.update({
      where: { id: operation.id },
      data: {
        state: event.data.outcome,
        settlement_revision: event.revision,
        settlement_batch_id: batch.id,
        settlement_payload: event as Prisma.InputJsonValue,
        settlement_identity: identity,
        settlement_digest: digest,
        settlement_outcome: event.data.outcome,
      },
    });
    const feeCap =
      source.chain === 'ethereum' && source.network === '11155111'
        ? 5000000000000000n
        : source.chain === 'bitcoin' && ['regtest', 'testnet'].includes(source.network)
          ? 10000n
          : source.chain === 'solana' &&
              ['devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'].includes(source.network)
            ? 100000n
            : undefined;
    const actualFee = event.data.actualFees.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
    if (
      (feeCap !== undefined && actualFee > feeCap) ||
      (costs &&
        (actualFee > BigInt(costs.maximumFeeUnits) || rent > BigInt(costs.maximumRentUnits)))
    )
      await this.incident(
        tx,
        event,
        'Actual network cost exceeds exchange-financial-v1; cost recorded and execution requires policy review',
      );
    const custodyPostings = new Map(
      postings
        .filter((posting) => posting.account.type.startsWith('custody_'))
        .map((posting) => [canonical(posting.account), posting]),
    );
    for (const posting of custodyPostings.values()) {
      if ((await this.journal.balance(tx, posting.account)) < 0n)
        await this.incident(
          tx,
          event,
          'Canonical settlement exceeds observed custody; reconcile and fund the shortfall',
        );
    }
    await this.publishSettlementResult(
      tx,
      {
        ...resultIdentity(event),
        operationId: event.operationId,
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        type: 'settlement.committed.v1',
        data: { ledgerBatchId: batch.id, transactionHash: hash },
      },
      `settlement-result:${operation.id}:${event.revision}`,
    );
  }

  private async revert(tx: Prisma.TransactionClient, event: RevertEvent, batchId?: string) {
    await this.requireBatchContext(tx, event.operationId, batchId);
    if (event.revision <= event.data.priorSettlementRevision)
      throw new ActionRejectedError('Reversal revision must follow its referenced settlement');
    const reversals = await this.reversals(tx, event);
    const accepted = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    if (accepted) {
      await this.operation(tx, event);
      await this.retainCanonicalEvent(tx, event);
    }
    const duplicate = reversals.find((row) => row.revision === event.revision);
    if (duplicate) {
      if (duplicate.data_digest !== exchangeDigest(event.data))
        throw new ActionRejectedError('Reversal revision has conflicting content');
      return;
    }
    const existing = await tx.exchangeOperation.findUnique({ where: { id: event.operationId } });
    const operation = existing ? await this.operation(tx, event) : undefined;
    if (
      operation &&
      event.revision >= operation.settlement_revision &&
      ((event.revision === operation.settlement_revision && operation.state !== 'reverted') ||
        (operation.state !== 'reverted' &&
          operation.settlement_batch_id &&
          event.data.priorSettlementRevision < operation.settlement_revision))
    )
      throw new ActionRejectedError('Reversal must identify the current settled revision');
    await tx.settlementReversal.create({
      data: {
        operation_id: event.operationId,
        revision: event.revision,
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        attempt_id: event.attemptId,
        request_digest: event.requestDigest,
        customer_id: operation?.customer_id ?? event.customerId,
        prior_settlement_revision: event.data.priorSettlementRevision,
        data_digest: exchangeDigest(event.data),
        payload: event as Prisma.InputJsonValue,
        ...(operation?.settlement_revision === event.data.priorSettlementRevision &&
        operation.settlement_digest
          ? {
              prior_settlement_digest: operation.settlement_digest,
              prior_settlement_payload: operation.settlement_payload as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (operation && event.revision <= operation.settlement_revision) return;
    if (!operation || !operation.settlement_batch_id || operation.state === 'reverted') {
      if (operation)
        await tx.exchangeOperation.update({
          where: { id: operation.id },
          data: { state: 'reverted', settlement_revision: event.revision },
        });
      // No settlement was posted, so there is no batch to compensate or reversed result
      // to publish. The durable fence and incident retain the obligation/resources.
      await this.incident(tx, event, event.data.reason);
      return;
    }
    const original = await tx.ledgerEntry.findMany({
      where: { batch_id: operation.settlement_batch_id },
      include: { account: true },
      orderBy: { sequence: 'asc' },
    });
    const postings: JournalPosting[] = [];
    let deficit = false;
    for (const entry of original) {
      const account = entry.account!;
      const spec: AccountSpec = {
        domainId: account.domain_id,
        chain: account.chain,
        network: account.network,
        assetId: account.asset_id,
        type: account.type,
        ownerKind: account.owner_kind,
        ownerId: account.owner_id,
        normalSide: account.normal_side,
      };
      const amount = BigInt(entry.amount.toFixed(0));
      const side = entry.side === 'credit' ? 'debit' : 'credit';
      if (side === 'debit' && ['customer_available', 'customer_frozen'].includes(account.type)) {
        const balance = await this.journal.balance(tx, spec);
        const usable = balance < amount ? balance : amount;
        if (usable > 0n) postings.push({ account: spec, side, amount: usable });
        if (usable < amount) {
          deficit = true;
          postings.push({
            account: this.account(
              event.domainId,
              {
                chain: account.chain as CanonicalAsset['chain'],
                network: account.network,
                assetId: account.asset_id,
              },
              'deficit',
              account.owner_id,
            ),
            side,
            amount: amount - usable,
          });
        }
      } else postings.push({ account: spec, side, amount });
    }
    const batch = await this.journal.post(tx, {
      key: `settlement-reversal:${operation.id}:${event.revision}`,
      domainId: event.domainId,
      operationId: operation.id,
      revision: event.revision,
      kind: 'settlement_reversal',
      postings,
      reversalOfBatchId: operation.settlement_batch_id,
    });
    if (operation.reservation_id) {
      const reservation = await tx.withdrawalReservation.findUniqueOrThrow({
        where: { id: operation.reservation_id },
      });
      await tx.withdrawalReservation.update({
        where: { id: reservation.id },
        data: { state: deficit ? 'frozen' : 'held' },
      });
      if (deficit)
        await tx.exchangeCustomer.update({
          where: { customer_id: reservation.customer_id },
          data: { state: 'frozen' },
        });
      if (deficit) {
        const availableAccounts = await tx.ledgerAccount.findMany({
          where: {
            domain_id: event.domainId,
            owner_kind: 'customer',
            owner_id: reservation.customer_id,
            type: 'customer_available',
          },
        });
        const freeze: JournalPosting[] = [];
        for (const account of availableAccounts) {
          const asset: CanonicalAsset = {
            chain: account.chain as CanonicalAsset['chain'],
            network: account.network,
            assetId: account.asset_id,
          };
          const available = this.account(
            event.domainId,
            asset,
            'customer_available',
            reservation.customer_id,
          );
          const amount = await this.journal.balance(tx, available);
          if (amount > 0n)
            freeze.push(
              { account: available, side: 'debit', amount },
              {
                account: this.account(
                  event.domainId,
                  asset,
                  'customer_frozen',
                  reservation.customer_id,
                ),
                side: 'credit',
                amount,
              },
            );
        }
        if (freeze.length)
          await this.journal.post(tx, {
            key: `settlement-reorg-freeze:${operation.id}:${event.revision}`,
            domainId: event.domainId,
            operationId: operation.id,
            revision: event.revision,
            kind: 'customer.freeze',
            postings: freeze,
          });
      }
    }
    await tx.exchangeOperation.update({
      where: { id: operation.id },
      data: { state: 'reverted', settlement_revision: event.revision },
    });
    await this.incident(
      tx,
      event,
      deficit
        ? 'Reorg restored an obligation after released funds were spent; customer frozen'
        : event.data.reason,
    );
    await this.publishSettlementResult(
      tx,
      {
        ...resultIdentity(event),
        operationId: event.operationId,
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        type: 'settlement.reversed.v1',
        data: {
          ledgerBatchId: batch.id,
          priorSettlementRevision: event.data.priorSettlementRevision,
          ...(operation.reservation_id ? { reservationId: operation.reservation_id } : {}),
        },
      },
      `settlement-reorg:${operation.id}:${event.revision}`,
    );
  }

  private async publishSettlementResult(
    tx: Prisma.TransactionClient,
    event: ExchangeEvent,
    key: string,
  ) {
    // Preserve Wallet's established dedupe key, then reuse the durable first
    // payload. A resumed producer cannot generate a different ID/time for Sweep.
    const walletDelivery = await enqueue(tx, QUEUES.wallet, event, key);
    await enqueue(
      tx,
      QUEUES.sweep,
      exchangeEventSchema.parse(walletDelivery.payload),
      `${key}:sweep`,
    );
  }

  private async retainCanonicalEvent(
    tx: Prisma.TransactionClient,
    event: SettlementEvent | RevertEvent,
  ) {
    const prior = await tx.ledgerAttemptCanonicalEvent.findUnique({
      where: { attempt_id_revision: { attempt_id: event.attemptId, revision: event.revision } },
    });
    if (prior) {
      const recorded = exchangeEventSchema.parse(prior.payload);
      if (prior.event_type !== event.type || canonical(recorded.data) !== canonical(event.data))
        throw new ActionRejectedError('Canonical attempt revision conflicts: conflicting content');
      return;
    }
    await tx.$executeRaw`SELECT retain_ledger_canonical_event(${JSON.stringify(event)}::jsonb, 'live')`;
  }

  private async incident(tx: Prisma.TransactionClient, event: ExchangeEvent, reason: string) {
    const id = randomUUID();
    const operation = event.operationId
      ? await tx.exchangeOperation.findUnique({ where: { id: event.operationId } })
      : undefined;
    const customerId = operation?.customer_id ?? event.customerId;
    const customer = customerId
      ? await tx.exchangeCustomer.findUnique({ where: { customer_id: customerId } })
      : undefined;
    await tx.ledgerIncident.create({
      data: {
        id,
        domain_id: event.domainId,
        operation_id: event.operationId,
        customer_id: customer?.domain_id === event.domainId ? customer.customer_id : undefined,
        reason,
        state: 'open',
      },
    });
    await publishExchangeEvent(
      tx,
      { ...event, ...(customerId ? { customerId } : {}) },
      {
        type: 'custody.incident.opened.v1',
        data: {
          incidentId: id,
          severity: 'critical',
          category: 'custody-reconciliation',
          status: 'open',
          reason,
        },
      },
      `incident:${id}`,
    );
  }
}
