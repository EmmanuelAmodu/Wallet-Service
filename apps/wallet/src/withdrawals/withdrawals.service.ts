import { BatchDraftsService } from '../execution/batch-drafts.service.js';
import {
  rolloutConfig,
  RolloutSettings,
  closedRollout,
  assertRollout,
} from '../../../../packages/shared/src/rollout.config.js';
import {
  Optional,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, Withdrawal } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { Message, MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import {
  executionDigest,
  executionUnitsSchema,
} from '../../../../packages/shared/src/execution-authorization.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { getWalletCore } from '../../../../packages/chain/src/coin-metadata.js';
import {
  assertEvmExternalAddress,
  assertSolanaExternalAddress,
} from '../../../../packages/chain/src/recipient-policy.js';
import { bitcoinWitnessAddress } from '../../../../packages/chain/src/bitcoin-address.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { CustodyService } from '../custody/custody.service.js';
import { ExchangeMessagingService } from '../exchange-messaging/exchange-messaging.service.js';
import { executionAssetSchema } from '../../../../packages/shared/src/execution-contracts.js';
import {
  tokenCertificateSchema,
  tokenAsset,
} from '../../../../packages/shared/src/token-contracts.js';
import { executionConfig, ExecutionSettings } from '../config/execution.config.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';

export const withdrawalRequestSchema = z
  .object({
    asset: executionAssetSchema,
    destination: z.string().min(1).max(256),
    amount: executionUnitsSchema.refine((n) => BigInt(n) > 0n),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
export type WithdrawalRequest = z.infer<typeof withdrawalRequestSchema>;
const json = (value: unknown) => value as Prisma.InputJsonValue;
type Reserve = Extract<ExchangeEvent, { type: 'withdrawal.reserve.requested.v1' }>;

export async function canonicalWithdrawalDestination(
  chain: WithdrawalRequest['asset']['chain'],
  address: string,
  network = 'regtest',
) {
  const core = await getWalletCore();
  const coin =
    chain === 'ethereum'
      ? core.CoinType.ethereum
      : chain === 'bitcoin'
        ? core.CoinType.bitcoin
        : core.CoinType.solana;
  if (chain === 'bitcoin') {
    try {
      const parsed = bitcoinWitnessAddress(address, network);
      if (parsed.program.length !== 20) throw new Error();
      return parsed.address;
    } catch {
      throw new BadRequestException(
        'Bitcoin withdrawals require canonical P2WPKH destinations on the selected network',
      );
    }
  }
  if (!core.AnyAddress.isValid(address, coin))
    throw new BadRequestException('Invalid withdrawal destination');
  if (chain === 'ethereum') {
    assertEvmExternalAddress(address);
    if (/^0x0{40}$/i.test(address)) throw new BadRequestException('Invalid withdrawal destination');
    return address.toLowerCase();
  }
  if (address === '11111111111111111111111111111111')
    throw new BadRequestException('Invalid withdrawal destination');
  await assertSolanaExternalAddress(address);
  return address;
}

@Injectable()
export class WithdrawalsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: WalletPrismaService,
    private readonly custody: CustodyService,
    private readonly exchange: ExchangeMessagingService,
    private readonly auth: MessageAuth,
    @Inject(walletConfig.KEY) private readonly settings: WalletConfig,
    @Inject(executionConfig.KEY) private readonly execution: ExecutionSettings,
    @Optional()
    @Inject(rolloutConfig.KEY)
    private readonly rollout: RolloutSettings = closedRollout,
    @Optional() private readonly batchDrafts?: BatchDraftsService,
  ) {}

  onModuleInit() {
    if (!this.execution.withdrawalsEnabled && !this.execution.tokensEnabled) return;
    this.timer = setInterval(() => this.tick(), this.execution.pollIntervalMs);
    this.tick();
  }

  private tick() {
    if (!this.running)
      this.running = this.repairDue()
        .catch(() => undefined)
        .finally(() => {
          this.running = undefined;
        });
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private view(w: Withdrawal) {
    return {
      id: w.id,
      asset: { chain: w.chain, network: w.network, assetId: w.asset_id },
      destination: w.destination,
      amount: w.principal_units,
      customerFee: w.customer_fee_units,
      policyVersion: w.policy_version,
      state: w.state,
      reason: w.reason,
      transactionHash: w.transaction_hash,
      createdAt: w.created_at.toISOString(),
      updatedAt: w.updated_at.toISOString(),
    };
  }

  async get(customerId: string, id: string) {
    const w = await this.db.withdrawal.findFirst({
      where: {
        id,
        customer_id: customerId,
        domain_id: this.settings.domainId,
        reset_epoch: this.auth.resetEpoch,
      },
    });
    if (!w) throw new NotFoundException('Withdrawal not found');
    return this.view(w);
  }

  async list(customerId: string, cursor?: string, limit = 50) {
    if (
      cursor &&
      !(await this.db.withdrawal.findFirst({
        where: {
          id: cursor,
          customer_id: customerId,
          domain_id: this.settings.domainId,
          reset_epoch: this.auth.resetEpoch,
        },
      }))
    )
      throw new BadRequestException('Invalid withdrawal cursor');
    const rows = await this.db.withdrawal.findMany({
      where: {
        customer_id: customerId,
        domain_id: this.settings.domainId,
        reset_epoch: this.auth.resetEpoch,
      },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit,
    });
    return {
      items: rows.map((w) => this.view(w)),
      nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
    };
  }

  async request(customerId: string, input: WithdrawalRequest) {
    const parsed = withdrawalRequestSchema.parse(input);
    const destination = await canonicalWithdrawalDestination(
      parsed.asset.chain,
      parsed.destination,
      parsed.asset.network,
    );
    const body = { asset: parsed.asset, destination, amount: parsed.amount };
    const digest = executionDigest({
      domainId: this.settings.domainId,
      resetEpoch: this.auth.resetEpoch,
      customerId,
      ...body,
      policyVersion: 'exchange-financial-v1',
    });
    const row = await this.db.$transaction(async (tx) => {
      await lock(tx, `withdrawal-request:${customerId}:${parsed.idempotencyKey}`);
      const previous = await tx.withdrawal.findUnique({
        where: {
          customer_id_idempotency_key: {
            customer_id: customerId,
            idempotency_key: parsed.idempotencyKey,
          },
        },
      });
      if (previous) {
        if (previous.request_digest !== digest)
          throw new ConflictException('Idempotency key was used for a different withdrawal');
        return previous;
      }
      assertRollout(this.rollout, 'withdrawals', {
        domainId: this.settings.domainId!,
        ...parsed.asset,
      });
      if (
        !(parsed.asset.assetId.endsWith(':native')
          ? this.execution.withdrawalsEnabled
          : this.execution.tokensEnabled)
      )
        throw new ServiceUnavailableException('Withdrawal execution is disabled');
      const customer = await tx.exchangeCustomer.findUnique({ where: { customer_id: customerId } });
      if (
        !customer ||
        customer.domain_id !== this.settings.domainId ||
        customer.reset_epoch !== this.auth.resetEpoch ||
        customer.state !== 'active' ||
        customer.ledger_status !== 'ready'
      )
        throw new ConflictException('Customer is not ready for withdrawals');
      const hot = await tx.wallet.findFirst({
        where: {
          custody_domain_id: this.settings.domainId,
          reset_epoch: this.auth.resetEpoch,
          custody_role: 'hot',
          account: 0,
          chain: parsed.asset.chain,
          network: parsed.asset.network,
          active: true,
        },
      });
      const asset = await tx.assetConfiguration.findUnique({
        where: {
          domain_id_chain_network_asset_id: {
            domain_id: this.settings.domainId,
            chain: parsed.asset.chain,
            network: parsed.asset.network,
            asset_id: parsed.asset.assetId,
          },
        },
      });
      const registry = hot
        ? await tx.exchangeWalletRegistry.findUnique({ where: { wallet_id: hot.id } })
        : null;
      if (
        !hot?.address ||
        !hot.published_at ||
        !(await this.custody.publicationAllowed(tx, hot)) ||
        registry?.ledger_status !== 'ready' ||
        registry.registry_revision !== hot.registry_revision ||
        registry.ledger_ack_revision !== hot.registry_revision ||
        !asset?.withdrawal_enabled
      )
        throw new ConflictException('Hot custody or withdrawal asset is not ready');
      if (!parsed.asset.assetId.endsWith(':native')) {
        const certificate = tokenCertificateSchema.parse(asset!.transfer_certificate);
        if (
          canonicalAsset(tokenAsset(certificate)) !== canonicalAsset(parsed.asset) ||
          asset!.decimals !== certificate.decimals
        )
          throw new ConflictException('Token transfer certificate mismatch');
      }
      if (parsed.asset.chain === 'bitcoin' && BigInt(parsed.amount) < 546n)
        throw new BadRequestException('Bitcoin withdrawal is below the conservative dust floor');
      if (
        (parsed.asset.chain === 'bitcoin' && BigInt(parsed.amount) > 2_100_000_000_000_000n) ||
        (parsed.asset.chain === 'solana' && BigInt(parsed.amount) > 18_446_744_073_709_551_615n)
      )
        throw new BadRequestException('Withdrawal exceeds asset unit range');
      if (
        (await tx.wallet.findFirst({
          where: {
            chain: parsed.asset.chain,
            network: parsed.asset.network,
            address:
              parsed.asset.chain === 'solana'
                ? destination
                : { equals: destination, mode: 'insensitive' },
          },
        })) ||
        (await tx.exchangeWalletRegistry.findFirst({
          where: {
            chain: parsed.asset.chain,
            network: parsed.asset.network,
            address:
              parsed.asset.chain === 'solana'
                ? destination
                : { equals: destination, mode: 'insensitive' },
          },
        }))
      )
        throw new BadRequestException('Exchange-owned destinations require an internal transfer');
      const id = randomUUID();
      const event = exchangeEventSchema.parse({
        eventId: randomUUID(),
        schemaVersion: 1,
        resetEpoch: this.auth.resetEpoch,
        occurredAt: new Date().toISOString(),
        domainId: this.settings.domainId,
        correlationId: id,
        causationId: null,
        aggregateId: id,
        revision: 1,
        customerId,
        operationId: id,
        requestDigest: digest,
        policyVersion: 'exchange-financial-v1',
        type: 'withdrawal.reserve.requested.v1',
        data: {
          amounts: [{ asset: parsed.asset, amount: parsed.amount }],
          principal: { asset: parsed.asset, amount: parsed.amount },
          hotWalletId: hot.id,
          destination,
          quoteExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      }) as Reserve;
      const w = await tx.withdrawal.create({
        data: {
          id,
          customer_id: customerId,
          domain_id: this.settings.domainId,
          reset_epoch: this.auth.resetEpoch,
          idempotency_key: parsed.idempotencyKey,
          request_digest: digest,
          request: json(event),
          chain: parsed.asset.chain,
          network: parsed.asset.network,
          asset_id: parsed.asset.assetId,
          destination,
          principal_units: parsed.amount,
          policy_version: 'exchange-financial-v1',
          hot_wallet_id: hot.id,
          hot_registry_revision: hot.registry_revision,
          state: 'reserving',
        },
      });
      await this.exchange.publishOperation(event, [QUEUES.ledger], tx);
      return w;
    });
    return this.view(row);
  }

  private event(w: Withdrawal, type: string, data: unknown, revision = w.revision) {
    const source = w.request as unknown as Reserve;
    return exchangeEventSchema.parse({
      ...source,
      type,
      data,
      eventId: randomUUID(),
      revision,
      occurredAt: new Date().toISOString(),
      causationId: source.eventId,
      ...(w.attempt_id ? { attemptId: w.attempt_id } : {}),
    });
  }

  private async release(tx: Prisma.TransactionClient, w: Withdrawal, reason: string) {
    if (!w.reservation_id) return;
    await enqueueFanOut(
      tx,
      this.event(
        w,
        'reservation.release.requested.v1',
        { reservationId: w.reservation_id, reason },
        w.revision,
      ),
      [QUEUES.ledger],
    );
  }

  async cancel(customerId: string, id: string) {
    const snapshot = await this.db.withdrawal.findFirst({
      where: {
        id,
        customer_id: customerId,
        domain_id: this.settings.domainId,
        reset_epoch: this.auth.resetEpoch,
      },
    });
    if (!snapshot) throw new NotFoundException('Withdrawal not found');
    const row = await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${snapshot.hot_wallet_id}`);
      await lock(tx, `withdrawal:${id}`);
      await tx.$queryRaw`SELECT id FROM withdrawals WHERE id=${id}::uuid FOR UPDATE`;
      let w = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
      if (w.batch_draft_id) {
        if (
          !this.batchDrafts ||
          (await tx.bitcoinBatchExecution.findUnique({ where: { batch_id: w.batch_draft_id } }))
        )
          throw new ConflictException('Admitted batch members cannot be cancelled independently');
        await this.batchDrafts.releaseWithin(tx, w.batch_draft_id);
        w = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
      }
      if (['cancelled', 'rejected'].includes(w.state)) return w;
      const execution = await tx.custodyExecution.findUnique({ where: { operation_id: id } });
      if (
        execution &&
        (execution.authorization || !['planning', 'prepared', 'deferred'].includes(execution.state))
      )
        throw new ConflictException('Authorized or uncertain withdrawal cannot be cancelled');
      if (
        ['settled', 'failed', 'reconciliation_required', 'executing', 'attention'].includes(
          w.state,
        ) &&
        !w.cancel_requested
      )
        throw new ConflictException('Withdrawal cannot be cancelled in its current state');
      if (execution && !execution.retired_at) {
        await tx.custodyExecution.update({
          where: { id: execution.id },
          data: {
            state: 'deferred',
            retired_at: new Date(),
            last_error: 'Cancelled before authorization',
          },
        });
        await tx.transaction.update({
          where: { id: execution.transaction_id },
          data: { status: 'rejected', last_error: 'Cancelled before authorization' },
        });
        await tx.executionResourceClaim.updateMany({
          where: { execution_id: execution.id, active: true },
          data: { active: false, released_at: new Date() },
        });
      }
      const updated = await tx.withdrawal.update({
        where: { id },
        data: {
          cancel_requested: true,
          state: 'cancelling',
          reason: 'Cancellation requested before authorization',
          revision: { increment: 1 },
          next_check_at: new Date(),
        },
      });
      await this.release(tx, updated, 'customer_cancelled');
      return updated;
    });
    return this.view(row);
  }

  async handle(message: Message): Promise<boolean> {
    if (!('operationId' in message) || !message.operationId) return false;
    const snapshot = await this.db.withdrawal.findUnique({ where: { id: message.operationId } });
    if (!snapshot) return false;
    if (
      ![
        'withdrawal.reserved.v1',
        'withdrawal.reserve.rejected.v1',
        'reservation.released.v1',
        'reservation.release.rejected.v1',
        'withdrawal.plan.prepared.v1',
        'withdrawal.plan.deferred.v1',
        'execution.attempt.updated.v1',
        'settlement.committed.v1',
        'settlement.reversed.v1',
      ].includes(message.type)
    )
      return false;
    const event = exchangeEventSchema.parse(message);
    if (
      event.domainId !== snapshot.domain_id ||
      event.resetEpoch !== snapshot.reset_epoch ||
      event.resetEpoch !== this.auth.resetEpoch ||
      event.customerId !== snapshot.customer_id ||
      event.requestDigest !== snapshot.request_digest ||
      ('attemptId' in event && event.attemptId && event.attemptId !== snapshot.attempt_id)
    )
      throw new ActionRejectedError('Withdrawal result identity mismatch');
    await this.db.$transaction(async (tx) => {
      await lock(tx, `withdrawal:${snapshot.id}`);
      const w = await tx.withdrawal.findUniqueOrThrow({ where: { id: snapshot.id } });
      if (event.type === 'withdrawal.reserved.v1') {
        if (w.reservation_id && w.reservation_id !== event.data.reservationId)
          throw new ActionRejectedError('Withdrawal hold identity changed');
        if (
          event.revision <= w.reservation_revision ||
          !['reserving', 'cancelling'].includes(w.state)
        )
          return;
        const updated = await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            reservation_id: event.data.reservationId,
            reservation_revision: event.revision,
            state: w.cancel_requested ? 'cancelling' : 'queued',
            revision: { increment: 1 },
            next_check_at: new Date(),
          },
        });
        if (updated.cancel_requested) await this.release(tx, updated, 'customer_cancelled');
      } else if (event.type === 'withdrawal.reserve.rejected.v1') {
        if (event.revision <= w.reservation_revision || w.reservation_id) return;
        await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            state: 'rejected',
            reason: event.data.code,
            reservation_revision: event.revision,
            revision: { increment: 1 },
          },
        });
      } else if (
        event.type === 'reservation.released.v1' ||
        event.type === 'reservation.release.rejected.v1'
      ) {
        if (event.data.reservationId !== w.reservation_id || !w.cancel_requested)
          throw new ActionRejectedError('Unexpected withdrawal release result');
        if (event.revision <= w.reservation_revision) return;
        await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            state: event.type === 'reservation.released.v1' ? 'cancelled' : 'attention',
            reason: event.type === 'reservation.release.rejected.v1' ? event.data.reason : null,
            reservation_revision: event.revision,
            revision: { increment: 1 },
          },
        });
      } else if (event.type === 'withdrawal.plan.prepared.v1') {
        if (w.cancel_requested || !['planning', 'waiting_liquidity'].includes(w.state)) return;
        const execution = await tx.custodyExecution.findUnique({ where: { operation_id: w.id } });
        if (
          !execution ||
          execution.state !== 'prepared' ||
          execution.preparation_digest !== event.data.preparationDigest ||
          event.data.amount.amount !== w.principal_units ||
          execution.customer_id !== w.customer_id ||
          execution.source_wallet_id !== w.hot_wallet_id ||
          event.data.sourceWalletId !== w.hot_wallet_id ||
          event.data.destinationWalletId !== w.hot_wallet_id ||
          execution.request_digest !== w.request_digest ||
          execution.attempt_id !== w.attempt_id ||
          execution.authorization ||
          execution.retired_at ||
          execution.preparation_digest !== event.data.preparationDigest ||
          canonicalAsset(event.data.amount.asset) !==
            canonicalAsset((w.request as unknown as Reserve).data.principal.asset)
        )
          throw new ActionRejectedError('Withdrawal preparation mismatch');
        const execute = this.event(w, 'withdrawal.execute.requested.v1', {
          sourceWalletId: w.hot_wallet_id,
          destination: w.destination,
          amount: { asset: event.data.amount.asset, amount: w.principal_units },
          preparationDigest: event.data.preparationDigest,
          ...(event.data.tokenCosts ? { tokenCosts: event.data.tokenCosts } : {}),
        });
        await enqueueFanOut(tx, execute, [QUEUES.wallet]);
      } else if (event.type === 'withdrawal.plan.deferred.v1') {
        const execution = await tx.custodyExecution.findUnique({ where: { operation_id: w.id } });
        if (
          execution &&
          execution.retired_at &&
          !execution.authorization &&
          execution.state === 'deferred' &&
          event.data.terminalSafe === true &&
          (execution.preparation_digest ?? undefined) === event.data.preparationDigest
        ) {
          const updated = await tx.withdrawal.update({
            where: { id: w.id },
            data: {
              state: 'cancelling',
              cancel_requested: true,
              reason: event.data.reason,
              revision: { increment: 1 },
              next_check_at: new Date(),
            },
          });
          await this.release(tx, updated, 'unsigned_execution_failed');
        } else if (!execution && !w.cancel_requested) {
          await tx.withdrawal.update({
            where: { id: w.id },
            data: {
              state: 'queued',
              reason: event.data.reason,
              revision: { increment: 1 },
              next_check_at: new Date(Date.now() + this.execution.pollIntervalMs),
            },
          });
        }
      } else if (event.type === 'execution.attempt.updated.v1') {
        if (
          event.revision <= w.execution_revision ||
          w.cancel_requested ||
          ['cancelled', 'rejected'].includes(w.state)
        )
          return;
        const execution = await tx.custodyExecution.findUnique({ where: { operation_id: w.id } });
        if (
          !execution ||
          execution.revision !== event.revision ||
          execution.attempt_id !== event.attemptId
        )
          return;
        let state = 'executing';
        if (event.data.state === 'attention') state = 'attention';
        if (event.data.state === 'preparing')
          state = /liquidity|fund|balance|unspent|mature/i.test(event.data.reason ?? '')
            ? 'waiting_liquidity'
            : 'planning';
        if (event.data.terminalSafe) {
          if (
            !execution.retired_at ||
            execution.reversed ||
            execution.ledger_ack_revision !== execution.settlement_revision ||
            execution.terminal_proof_revision !== execution.settlement_revision ||
            event.data.settlementRevision !== execution.settlement_revision ||
            !['confirmed', 'failed'].includes(execution.state)
          )
            throw new ActionRejectedError('Withdrawal terminal proof is not committed');
          state = execution.state === 'confirmed' ? 'settled' : 'failed';
        }
        if (execution.reversed) state = 'reconciliation_required';
        await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            state,
            reason: event.data.reason ?? null,
            execution_revision: event.revision,
            settlement_revision: Math.max(
              w.settlement_revision,
              event.data.settlementRevision ?? 0,
            ),
            transaction_hash: event.data.transactionHash ?? w.transaction_hash,
            revision: { increment: 1 },
          },
        });
      } else if (event.type === 'settlement.reversed.v1') {
        if (event.revision <= w.settlement_revision) return;
        await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            state: 'reconciliation_required',
            reason: 'Outgoing settlement reversed; obligation restored and review required',
            settlement_revision: event.revision,
            revision: { increment: 1 },
          },
        });
      }
    });
    return true;
  }

  private async queuePlan(tx: Prisma.TransactionClient, w: Withdrawal) {
    const reserve = w.request as unknown as Reserve;
    await enqueueFanOut(
      tx,
      this.event(w, 'withdrawal.plan.requested.v1', {
        sourceWalletId: w.hot_wallet_id,
        destinationWalletId: w.hot_wallet_id,
        asset: reserve.data.principal.asset,
        sourceRegistryRevision: w.hot_registry_revision,
        hotRegistryRevision: w.hot_registry_revision,
        generation: 0,
        destination: w.destination,
        amount: w.principal_units,
        reservationId: w.reservation_id,
      }),
      [QUEUES.wallet],
    );
  }

  async repairDue() {
    if (!this.execution.withdrawalsEnabled && !this.execution.tokensEnabled) return;
    const rows = await this.db.withdrawal.findMany({
      where: {
        domain_id: this.settings.domainId,
        reset_epoch: this.auth.resetEpoch,
        batch_draft_id: null,
        state: {
          in: [
            'reserving',
            'queued',
            'cancelling',
            'planning',
            'waiting_liquidity',
            'executing',
            'attention',
            'reconciliation_required',
          ],
        },
        next_check_at: { lte: new Date() },
      },
      orderBy: [{ next_check_at: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      take: 40,
    });
    for (const snapshot of rows)
      await this.db.$transaction(async (tx) => {
        await lock(tx, `custody-source:${snapshot.hot_wallet_id}`);
        await lock(tx, `withdrawal:${snapshot.id}`);
        const w = await tx.withdrawal.findUniqueOrThrow({ where: { id: snapshot.id } });
        if (w.batch_draft_id) return;
        if (
          this.execution.bitcoinBatchesEnabled &&
          w.state === 'queued' &&
          w.chain === 'bitcoin' &&
          w.asset_id === 'token:bitcoin:native' &&
          !w.cancel_requested &&
          (await tx.withdrawal.count({
            where: {
              hot_wallet_id: w.hot_wallet_id,
              state: 'queued',
              customer: { state: 'active', ledger_status: 'ready' },
              batch_draft_id: null,
              attempt_id: null,
              cancel_requested: false,
              reservation_id: { not: null },
              asset_id: 'token:bitcoin:native',
            },
          })) >= 2
        )
          return;
        await tx.withdrawal.update({
          where: { id: w.id },
          data: { next_check_at: new Date(Date.now() + this.execution.pollIntervalMs) },
        });
        if (w.state === 'reserving' || (w.state === 'cancelling' && !w.reservation_id)) {
          const reserve = w.request as unknown as Reserve;
          await enqueueFanOut(tx, { ...reserve, eventId: randomUUID() }, [QUEUES.ledger]);
        } else if (w.state === 'cancelling') {
          await this.release(tx, w, 'safe_cancellation_repair');
        } else if (
          [
            'planning',
            'waiting_liquidity',
            'executing',
            'attention',
            'reconciliation_required',
          ].includes(w.state) &&
          !w.cancel_requested
        ) {
          const current = await tx.custodyExecution.findUnique({
            where: { operation_id: w.id },
            include: { transaction: true },
          });
          const reserve = w.request as unknown as Reserve;
          if (!current && w.attempt_id) {
            await this.queuePlan(tx, w);
          } else if (
            current?.state === 'prepared' &&
            current.expires_at &&
            current.expires_at.getTime() > Date.now()
          ) {
            await enqueueFanOut(
              tx,
              this.event(w, 'withdrawal.plan.prepared.v1', {
                sourceWalletId: w.hot_wallet_id,
                destinationWalletId: w.hot_wallet_id,
                amount: reserve.data.principal,
                preparationDigest: current.preparation_digest,
                maxFeeUnits: current.maximum_fee_units,
                expiresAt: current.expires_at.toISOString(),
              }),
              [QUEUES.wallet],
            );
          } else if (
            current?.state === 'deferred' &&
            current.retired_at &&
            !current.authorization
          ) {
            await enqueueFanOut(
              tx,
              this.event(w, 'withdrawal.plan.deferred.v1', {
                code: 'unsigned_execution_failed',
                reason: current.last_error ?? 'Unsigned execution closed',
                retryAfter: new Date().toISOString(),
                terminalSafe: true,
                ...(current.preparation_digest
                  ? { preparationDigest: current.preparation_digest }
                  : {}),
              }),
              [QUEUES.wallet],
            );
          } else if (
            current &&
            current.revision > w.execution_revision &&
            [
              'planning',
              'signing',
              'queued',
              'submitted',
              'confirmed',
              'failed',
              'attention',
            ].includes(current.state)
          ) {
            const terminalSafe =
              !!current.retired_at &&
              !current.reversed &&
              current.settlement_revision > 0 &&
              current.ledger_ack_revision === current.settlement_revision &&
              current.terminal_proof_revision === current.settlement_revision &&
              ['confirmed', 'failed'].includes(current.state);
            await enqueueFanOut(
              tx,
              this.event(
                w,
                'execution.attempt.updated.v1',
                {
                  state: current.state === 'planning' ? 'preparing' : current.state,
                  ...(current.transaction.tx_hash
                    ? { transactionHash: current.transaction.tx_hash }
                    : {}),
                  ...(current.last_error ? { reason: current.last_error } : {}),
                  terminalSafe,
                  ...(terminalSafe ? { settlementRevision: current.settlement_revision } : {}),
                },
                current.revision,
              ),
              [QUEUES.wallet],
            );
          }
        } else if (w.state === 'queued' && !w.cancel_requested) {
          if (
            (await tx.custodyExecution.findFirst({
              where: { source_wallet_id: w.hot_wallet_id, retired_at: null },
            })) ||
            (await tx.withdrawal.findFirst({
              where: {
                id: { not: w.id },
                hot_wallet_id: w.hot_wallet_id,
                state: {
                  in: [
                    'planning',
                    'waiting_liquidity',
                    'executing',
                    'attention',
                    'reconciliation_required',
                  ],
                },
              },
            }))
          )
            return;
          const attempt = w.attempt_id ?? randomUUID();
          const updated = await tx.withdrawal.update({
            where: { id: w.id },
            data: { attempt_id: attempt, state: 'planning', revision: { increment: 1 } },
          });
          await this.queuePlan(tx, updated);
        }
      });
  }
}

function canonicalAsset(asset: { chain: string; network: string; assetId: string }) {
  return JSON.stringify([asset.chain, asset.network, asset.assetId]);
}
