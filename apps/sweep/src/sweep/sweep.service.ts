import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Prisma as SweepPrisma,
  SweepWalletRegistration,
  SweepWork,
  SweepOperation,
  SweepAttempt,
} from '.prisma/sweep-client';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  CanonicalAsset,
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { MessageAuth, canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { chainFamily } from '../../../../packages/shared/src/contracts.js';
import { sweepConfig } from '../config/sweep.config.js';
import { SweepPrismaService } from '../prisma/prisma.service.js';

type RegistryEvent = Extract<
  ExchangeEvent,
  { type: 'customer-wallet.registry.requested.v1' | 'custody-wallet.registry.requested.v1' }
>;
type DepositResult = Extract<
  ExchangeEvent,
  { type: 'deposit.credited.v1' | 'deposit.reversed.v1' }
>;

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

type ExecutionEvent = Extract<
  ExchangeEvent,
  {
    type:
      | 'sweep.plan.prepared.v1'
      | 'sweep.plan.deferred.v1'
      | 'execution.attempt.updated.v1'
      | 'settlement.committed.v1'
      | 'settlement.reversed.v1';
  }
>;
type SweepSettings = Pick<ConfigType<typeof sweepConfig>, 'domainId'> &
  Partial<
    Pick<
      ConfigType<typeof sweepConfig>,
      'enableNativeSweeps' | 'policyVersion' | 'retryDelayMs' | 'reconciliationIntervalMs'
    >
  >;

// Wallet owns chain reads, resource claims, signing and broadcasting. This service
// owns a durable saga and only releases work after independently ordered proof.
@Injectable()
export class SweepService {
  constructor(
    private readonly db: SweepPrismaService,
    private readonly auth: MessageAuth,
    @Inject(sweepConfig.KEY)
    private readonly config: SweepSettings,
  ) {}

  async handle(input: ExchangeEvent) {
    const event = exchangeEventSchema.parse(input);
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale reset epoch');
    if (event.domainId !== this.config.domainId)
      throw new ActionRejectedError('Event belongs to a different exchange custody domain');
    await this.db.$transaction(async (tx) => {
      // Serializes local registry and work projection so late hot/customer deliveries cannot race credits.
      await lock(tx, `sweep-domain:${event.domainId}:${event.resetEpoch}`);
      await lock(tx, `sweep-inbox:${event.eventId}`);
      const previous = await tx.inbox.findUnique({ where: { id: event.eventId } });
      const payloadHash = digest(event);
      if (previous) {
        if (
          previous.payload_hash !== payloadHash ||
          previous.domain_id !== event.domainId ||
          previous.reset_epoch !== event.resetEpoch
        )
          throw new ActionRejectedError('Sweep event ID was reused with different content');
        return;
      }
      switch (event.type) {
        case 'customer-wallet.registry.requested.v1':
        case 'custody-wallet.registry.requested.v1':
          await this.register(tx, event);
          break;
        case 'deposit.credited.v1':
        case 'deposit.reversed.v1':
          await this.projectDeposit(tx, event);
          break;
        case 'sweep.plan.prepared.v1':
        case 'sweep.plan.deferred.v1':
        case 'execution.attempt.updated.v1':
        case 'settlement.committed.v1':
        case 'settlement.reversed.v1':
          await this.executionResult(tx, event);
          break;
        case 'deposit.deficit-recorded.v1':
        case 'custody.loss.recorded.v1':
        case 'custody.loss.reverted.v1':
          await this.pauseCustomer(
            tx,
            event,
            'reason' in event.data ? event.data.reason : event.type,
          );
          break;
        case 'custody.incident.opened.v1':
        case 'custody.incident.updated.v1':
          if (event.data.severity === 'high' || event.data.severity === 'critical') {
            if (event.customerId) await this.pauseCustomer(tx, event, event.data.reason);
            else await this.pauseDomain(tx, event, event.data.reason);
          }
          break;
        case 'custody.incident.resolved.v1':
          // Resolution does not silently clear a custody review gate.
          break;
        default:
          throw new ActionRejectedError(
            'Unsupported sweep event; only accounted deposits schedule work',
          );
      }
      await tx.inbox.create({
        data: {
          id: event.eventId,
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
          payload_hash: payloadHash,
        },
      });
    });
  }

  /** Bounded, restart-safe reconciliation catches missed triggers and residual balances. */
  async scheduleEligible(limit = 100) {
    if (!this.config.enableNativeSweeps) return 0;
    const page = await this.db.sweepWork.findMany({
      where: {
        domain_id: this.config.domainId,
        reset_epoch: this.auth.resetEpoch,
        active_operation_id: null,
        state: {
          in: [
            'eligible',
            'deferred',
            'settled_residual',
            'blocked_execution_not_implemented',
            'awaiting_registry',
            'awaiting_hot_wallet',
          ],
        },
        OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: new Date() } }],
      },
      orderBy: [{ last_scanned_at: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 100)),
    });
    let processed = 0;
    for (const candidate of page) {
      try {
        await this.db.$transaction(async (tx) => {
          await lock(tx, `sweep-domain:${candidate.domain_id}:${candidate.reset_epoch}`);
          const work = await tx.sweepWork.findUniqueOrThrow({ where: { id: candidate.id } });
          await tx.sweepWork.update({
            where: { id: work.id },
            data: { last_scanned_at: new Date() },
          });
          if (
            work.active_operation_id ||
            (work.next_attempt_at && work.next_attempt_at > new Date())
          )
            return;
          const gate = await this.executionGate(tx, work);
          if (gate) {
            await tx.sweepWork.update({
              where: { id: work.id },
              data: { state: gate.state, reason: gate.reason },
            });
            if (gate.state === 'deferred_unsupported_asset')
              await this.exception(tx, work, null, 'unsupported_asset', gate.reason);
            return;
          }
          await this.startPlan(tx, work);
          processed++;
        });
      } catch (error) {
        // One malformed wallet must not starve unrelated wallets after restart.
        const reason = error instanceof Error ? error.message.slice(0, 500) : 'Scheduling failed';
        await this.db.sweepWork.updateMany({
          where: { id: candidate.id, active_operation_id: null },
          data: {
            state: 'deferred',
            scheduling_error: reason,
            reason,
            next_attempt_at: new Date(Date.now() + (this.config.retryDelayMs ?? 60000)),
            last_scanned_at: new Date(),
          },
        });
      }
    }
    return processed;
  }

  private async executionGate(tx: SweepPrisma.TransactionClient, work: SweepWork) {
    const customer = await tx.sweepCustomer.findUnique({
      where: { customer_id: work.customer_id },
    });
    const domain = await tx.sweepDomainGate.findUnique({
      where: {
        domain_id_reset_epoch: { domain_id: work.domain_id, reset_epoch: work.reset_epoch },
      },
    });
    if (
      !customer ||
      customer.domain_id !== work.domain_id ||
      customer.reset_epoch !== work.reset_epoch ||
      customer.paused ||
      domain
    )
      return {
        state: 'paused_review',
        reason: domain?.reason ?? customer?.pause_reason ?? 'Customer custody review required',
      };
    if (
      work.asset_id !== `token:${work.chain}:native` ||
      !['ethereum', 'bitcoin', 'solana'].includes(work.chain)
    )
      return {
        state: 'deferred_unsupported_asset',
        reason: 'Only initial native assets are supported',
      };
    const source = await tx.sweepWalletRegistration.findUnique({
      where: { wallet_id: work.source_wallet_id },
    });
    if (!source) return { state: 'awaiting_registry', reason: 'Awaiting source registry' };
    const hot = source.hot_wallet_id
      ? await tx.sweepWalletRegistration.findUnique({ where: { wallet_id: source.hot_wallet_id } })
      : null;
    if (!hot) return { state: 'awaiting_hot_wallet', reason: 'Awaiting account 0 hot registry' };
    if (
      source.domain_id !== work.domain_id ||
      source.reset_epoch !== work.reset_epoch ||
      source.role !== 'customer' ||
      source.customer_id !== work.customer_id ||
      source.account < 10 ||
      source.chain !== work.chain ||
      source.network !== work.network ||
      hot.domain_id !== work.domain_id ||
      hot.reset_epoch !== work.reset_epoch ||
      hot.role !== 'hot' ||
      hot.account !== 0 ||
      hot.chain !== work.chain ||
      hot.network !== work.network ||
      hot.wallet_id !== work.hot_wallet_id
    )
      return {
        state: 'paused_registry_identity',
        reason: 'Source/hot registry no longer matches custody identity',
      };
    return null;
  }

  private async startPlan(tx: SweepPrisma.TransactionClient, work: SweepWork) {
    const source = await tx.sweepWalletRegistration.findUniqueOrThrow({
      where: { wallet_id: work.source_wallet_id },
    });
    const hot = await tx.sweepWalletRegistration.findUniqueOrThrow({
      where: { wallet_id: work.hot_wallet_id! },
    });
    const operationId = randomUUID(),
      attemptId = randomUUID();
    const data = {
      sourceWalletId: source.wallet_id,
      destinationWalletId: hot.wallet_id,
      asset: { chain: work.chain, network: work.network, assetId: work.asset_id },
      sourceRegistryRevision: source.registry_revision,
      hotRegistryRevision: hot.registry_revision,
      generation: work.generation,
    };
    const identity = {
      domainId: work.domain_id,
      resetEpoch: work.reset_epoch,
      customerId: work.customer_id,
      operationId,
      attemptId,
      policyVersion: this.config.policyVersion ?? 'exchange-financial-v1',
      data,
    };
    const requestDigest = digest(identity);
    await tx.sweepOperation.create({
      data: {
        id: operationId,
        work_id: work.id,
        domain_id: work.domain_id,
        reset_epoch: work.reset_epoch,
        customer_id: work.customer_id,
        source_wallet_id: source.wallet_id,
        hot_wallet_id: hot.wallet_id,
        chain: work.chain,
        network: work.network,
        asset_id: work.asset_id,
        generation: work.generation,
        source_registry_revision: source.registry_revision,
        hot_registry_revision: hot.registry_revision,
        policy_version: identity.policyVersion,
        request_digest: requestDigest,
        supersedes_operation_id: work.last_operation_id,
        state: 'planning',
      },
    });
    await tx.sweepAttempt.create({
      data: { id: attemptId, operation_id: operationId, state: 'planning' },
    });
    const event = exchangeEventSchema.parse({
      ...identity,
      requestDigest,
      type: 'sweep.plan.requested.v1',
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: operationId,
      causationId: null,
      aggregateId: operationId,
      revision: 1,
    });
    await this.publish(tx, event, [QUEUES.wallet]);
    await tx.sweepWork.update({
      where: { id: work.id },
      data: {
        active_operation_id: operationId,
        last_operation_id: operationId,
        state: 'planning',
        reason: 'Awaiting authoritative Wallet preparation',
        scheduling_error: null,
        next_attempt_at: null,
      },
    });
  }

  private async publish(tx: SweepPrisma.TransactionClient, event: ExchangeEvent, queues: string[]) {
    for (const queue of queues)
      await tx.outbox.upsert({
        where: { dedupe_key: `${event.eventId}:${queue}` },
        update: {},
        create: {
          id: randomUUID(),
          queue,
          dedupe_key: `${event.eventId}:${queue}`,
          payload: event as unknown as SweepPrisma.InputJsonValue,
        },
      });
  }

  private async executionResult(tx: SweepPrisma.TransactionClient, event: ExecutionEvent) {
    const operation = await tx.sweepOperation.findUnique({ where: { id: event.operationId } });
    const attempt = await tx.sweepAttempt.findUnique({ where: { id: event.attemptId } });
    if (!operation) {
      if (event.type === 'sweep.plan.prepared.v1' || event.type === 'sweep.plan.deferred.v1')
        throw new ActionRejectedError('Unknown sweep plan identity');
      // Ledger settlement fanout also includes legacy, withdrawal and funding
      // operations. Only locally created Sweep identities may affect this saga.
      // Owned operations are committed before their transactional outbox is sent.
      return;
    }
    if (!attempt) throw new ActionRejectedError('Unknown sweep attempt identity');
    if (
      attempt.operation_id !== operation.id ||
      operation.domain_id !== event.domainId ||
      operation.reset_epoch !== event.resetEpoch ||
      operation.request_digest !== event.requestDigest ||
      (event.customerId && operation.customer_id !== event.customerId) ||
      (event.policyVersion && operation.policy_version !== event.policyVersion)
    )
      throw new ActionRejectedError('Sweep execution result identity mismatch');
    const work = await tx.sweepWork.findUniqueOrThrow({ where: { id: operation.work_id } });
    const hash = digest({ type: event.type, data: event.data });
    if (event.type === 'sweep.plan.deferred.v1') {
      const unsignedPreparation =
        attempt.execution_revision === 0 &&
        event.data.terminalSafe === true &&
        event.data.preparationDigest === attempt.preparation_digest &&
        ['prepared', 'queued', 'attention'].includes(attempt.state);
      const unprepared =
        !attempt.preparation_digest &&
        attempt.execution_revision === 0 &&
        ['planning', 'preparing', 'deferred'].includes(attempt.state);
      if (!unsignedPreparation && !unprepared)
        throw new ActionRejectedError(
          'Prepared or signed sweep cannot be deferred without terminal proof',
        );
      if (operation.terminal_at) return;
      const retryAt = new Date(event.data.retryAfter);
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: { state: 'deferred', terminal_safe: true },
      });
      await tx.sweepOperation.update({
        where: { id: operation.id },
        data: {
          state: 'deferred',
          reason: event.data.reason,
          terminal_at: new Date(),
          revision: { increment: 1 },
        },
      });
      const gate = await this.executionGate(tx, work);
      await tx.sweepWork.update({
        where: { id: work.id },
        data: {
          active_operation_id: null,
          state: gate?.state ?? 'deferred',
          reason: gate?.reason ?? event.data.reason,
          next_attempt_at: retryAt,
        },
      });
      await this.exception(tx, work, operation.id, event.data.code, event.data.reason);
      return;
    }
    if (event.type === 'sweep.plan.prepared.v1') {
      const data = event.data;
      if (
        data.sourceWalletId !== operation.source_wallet_id ||
        data.destinationWalletId !== operation.hot_wallet_id ||
        data.amount.asset.chain !== operation.chain ||
        data.amount.asset.network !== operation.network ||
        data.amount.asset.assetId !== operation.asset_id
      )
        throw new ActionRejectedError('Sweep preparation changed source, hot wallet or asset');
      if (attempt.preparation_digest) {
        if (
          attempt.preparation_digest !== data.preparationDigest ||
          attempt.amount !== data.amount.amount ||
          attempt.maximum_fee_units !== data.maxFeeUnits ||
          attempt.expires_at?.toISOString() !== new Date(data.expiresAt).toISOString()
        )
          throw new ActionRejectedError('Sweep preparation identity changed');
        return;
      }
      if (operation.terminal_at || work.active_operation_id !== operation.id)
        throw new ActionRejectedError('Sweep preparation belongs to a retired operation');
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: {
          preparation_digest: data.preparationDigest,
          amount: data.amount.amount,
          maximum_fee_units: data.maxFeeUnits,
          expires_at: new Date(data.expiresAt),
        },
      });
      const gate = await this.executionGate(tx, work);
      const source = await tx.sweepWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: operation.source_wallet_id },
      });
      const hot = await tx.sweepWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: operation.hot_wallet_id },
      });
      if (
        gate ||
        source.registry_revision !== operation.source_registry_revision ||
        hot.registry_revision !== operation.hot_registry_revision ||
        operation.policy_version !== (this.config.policyVersion ?? 'exchange-financial-v1') ||
        new Date(data.expiresAt) <= new Date()
      ) {
        const reason =
          gate?.reason ?? 'Preparation expired or registry revision changed before execution';
        await tx.sweepOperation.update({
          where: { id: operation.id },
          data: { state: 'attention', reason, revision: { increment: 1 } },
        });
        await tx.sweepAttempt.update({ where: { id: attempt.id }, data: { state: 'attention' } });
        await tx.sweepWork.update({
          where: { id: work.id },
          data: { state: gate?.state ?? 'attention', reason },
        });
        await this.exception(tx, work, operation.id, 'preparation_revalidation_failed', reason);
        // Wallet still owns unsigned resource claims. They remain fenced until it
        // proves expiry/terminal safety; no second operation is emitted here.
        return;
      }
      const executeId = randomUUID();
      const execute = exchangeEventSchema.parse({
        ...event,
        eventId: executeId,
        occurredAt: new Date().toISOString(),
        causationId: event.eventId,
        aggregateId: operation.id,
        revision: 1,
        customerId: operation.customer_id,
        policyVersion: operation.policy_version,
        type: 'sweep.execute.requested.v1',
        data: {
          sourceWalletId: operation.source_wallet_id,
          destinationWalletId: operation.hot_wallet_id,
          amount: data.amount,
          preparationDigest: data.preparationDigest,
        },
      });
      await this.publish(tx, execute, [QUEUES.wallet, QUEUES.ledger, QUEUES.activity]);
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: { state: 'queued', execute_event_id: executeId },
      });
      await tx.sweepOperation.update({
        where: { id: operation.id },
        data: { state: 'queued', revision: { increment: 1 } },
      });
      await tx.sweepWork.update({
        where: { id: work.id },
        data: { state: 'queued', reason: 'Exact prepared attempt queued for execution' },
      });
      return;
    }
    if (event.type === 'execution.attempt.updated.v1') {
      if (event.revision < attempt.execution_revision) return;
      if (event.revision === attempt.execution_revision) {
        if (hash !== attempt.execution_digest)
          throw new ActionRejectedError('Sweep execution revision content changed');
        return;
      }
      if (
        attempt.transaction_hash &&
        event.data.transactionHash &&
        attempt.transaction_hash !== event.data.transactionHash
      )
        throw new ActionRejectedError('Sweep transaction hash changed');
      if (event.data.terminalSafe && !['confirmed', 'failed'].includes(event.data.state))
        throw new ActionRejectedError('Sweep terminal proof requires confirmed or failed outcome');
      if (
        event.data.terminalSafe &&
        (!event.data.settlementRevision || !event.data.transactionHash)
      )
        throw new ActionRejectedError(
          'Sweep terminal proof requires canonical hash and settlement revision',
        );
      const terminalSafe = event.data.terminalSafe ?? false;
      // Reversal delivery can precede an old terminal notification.
      const fenced =
        attempt.reversal_fence_revision > 0 && attempt.settlement_state !== 'committed';
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: {
          state: fenced ? 'attention' : event.data.state,
          execution_revision: event.revision,
          execution_digest: hash,
          transaction_hash: event.data.transactionHash ?? attempt.transaction_hash,
          terminal_safe: terminalSafe && !fenced,
          terminal_settlement_revision:
            terminalSafe && !fenced ? event.data.settlementRevision : null,
        },
      });
      await tx.sweepOperation.update({
        where: { id: operation.id },
        data: {
          state: fenced ? 'attention' : event.data.state,
          reason: event.data.reason,
          revision: { increment: 1 },
        },
      });
      if (work.active_operation_id === operation.id) {
        const gate = await this.executionGate(tx, work);
        await tx.sweepWork.update({
          where: { id: work.id },
          data: {
            state: gate?.state ?? (fenced ? 'attention' : event.data.state),
            reason:
              gate?.reason ??
              event.data.reason ??
              'Awaiting canonical execution and ledger settlement proof',
          },
        });
      }
    } else if (event.type === 'settlement.committed.v1') {
      if (
        event.revision <= attempt.reversal_fence_revision ||
        event.revision < attempt.settlement_revision
      )
        return;
      if (event.revision === attempt.settlement_revision) {
        if (hash !== attempt.settlement_digest)
          throw new ActionRejectedError('Sweep settlement revision content changed');
        return;
      }
      if (attempt.transaction_hash && attempt.transaction_hash !== event.data.transactionHash)
        throw new ActionRejectedError('Sweep settlement transaction hash changed');
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: {
          settlement_revision: event.revision,
          settlement_digest: hash,
          settlement_state: 'committed',
          ledger_batch_id: event.data.ledgerBatchId,
          transaction_hash: event.data.transactionHash,
        },
      });
    } else if (event.type === 'settlement.reversed.v1') {
      if (
        event.revision < attempt.reversal_fence_revision ||
        event.revision < attempt.settlement_revision
      )
        return;
      if (event.revision === attempt.reversal_fence_revision) {
        if (attempt.settlement_state === 'reversed' && hash !== attempt.settlement_digest)
          throw new ActionRejectedError('Sweep reversal revision content changed');
        return;
      }
      await tx.sweepAttempt.update({
        where: { id: attempt.id },
        data: {
          settlement_state: 'reversed',
          settlement_revision: Math.max(attempt.settlement_revision, event.revision),
          settlement_digest: hash,
          reversal_fence_revision: event.revision,
          terminal_safe: false,
          terminal_settlement_revision: null,
          state: 'attention',
        },
      });
      await tx.sweepOperation.update({
        where: { id: operation.id },
        data: {
          state: 'attention',
          reason: 'Canonical sweep settlement reversed',
          revision: { increment: 1 },
          ...(work.active_operation_id && work.active_operation_id !== operation.id
            ? {}
            : { terminal_at: null }),
        },
      });
      await tx.sweepWork.update({
        where: { id: work.id },
        data: {
          active_operation_id: work.active_operation_id ?? operation.id,
          state: 'paused_review',
          reason: 'Canonical sweep settlement reversed',
        },
      });
      await this.pauseCustomer(
        tx,
        { ...event, customerId: operation.customer_id },
        'Canonical sweep settlement reversed',
      );
      await this.exception(
        tx,
        work,
        operation.id,
        'settlement_reversed',
        'Canonical sweep settlement reversed',
      );
      return;
    }
    const updated = await tx.sweepAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    await this.finishIfSafe(tx, operation, updated, work);
  }

  private async finishIfSafe(
    tx: SweepPrisma.TransactionClient,
    operation: SweepOperation,
    attempt: SweepAttempt,
    work: SweepWork,
  ) {
    if (
      !attempt.terminal_safe ||
      attempt.terminal_settlement_revision !== attempt.settlement_revision ||
      attempt.settlement_state !== 'committed' ||
      attempt.reversal_fence_revision >= attempt.settlement_revision ||
      !['confirmed', 'failed'].includes(attempt.state) ||
      work.active_operation_id !== operation.id
    )
      return;
    await tx.sweepOperation.update({
      where: { id: operation.id },
      data: { state: 'settled', terminal_at: new Date(), revision: { increment: 1 } },
    });
    const gate = await this.executionGate(tx, work);
    await tx.sweepWork.update({
      where: { id: work.id },
      data: {
        active_operation_id: null,
        consumed_generation: operation.generation,
        state: gate?.state ?? 'settled_residual',
        reason: gate?.reason ?? 'Recheck residual chain balance after settled sweep',
        next_attempt_at: new Date(Date.now() + (this.config.retryDelayMs ?? 60000)),
      },
    });
  }

  private async exception(
    tx: SweepPrisma.TransactionClient,
    work: SweepWork,
    operationId: string | null,
    category: string,
    reason: string,
  ) {
    const fingerprint = digest({ workId: work.id, operationId, category });
    await tx.sweepException.upsert({
      where: { fingerprint },
      create: {
        domain_id: work.domain_id,
        reset_epoch: work.reset_epoch,
        work_id: work.id,
        operation_id: operationId,
        category: category.slice(0, 64),
        reason: reason.slice(0, 500),
        fingerprint,
      },
      update: { occurrence_count: { increment: 1 }, reason: reason.slice(0, 500) },
    });
  }

  private async customer(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    customerId: string,
  ) {
    const prior = await tx.sweepCustomer.findUnique({ where: { customer_id: customerId } });
    if (prior && (prior.domain_id !== event.domainId || prior.reset_epoch !== event.resetEpoch))
      throw new ActionRejectedError('Sweep customer identity is immutable');
    return tx.sweepCustomer.upsert({
      where: { customer_id: customerId },
      create: { customer_id: customerId, domain_id: event.domainId, reset_epoch: event.resetEpoch },
      update: {},
    });
  }

  private async register(tx: SweepPrisma.TransactionClient, event: RegistryEvent) {
    const data = event.data;
    const customer = event.type === 'customer-wallet.registry.requested.v1';
    const identity = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      chain: data.chain,
      network: data.network,
      address: data.address,
      address_key:
        chainFamily(data.chain) === 'ethereum' ? data.address.toLowerCase() : data.address,
      role: customer ? 'customer' : event.data.role,
      account: data.account,
      customer_id: customer ? event.customerId : null,
      hot_wallet_id: customer ? event.data.hotWalletId : null,
    };
    const prior = await tx.sweepWalletRegistration.findUnique({
      where: { wallet_id: data.walletId },
    });
    if (prior) {
      for (const key of [
        'domain_id',
        'reset_epoch',
        'chain',
        'network',
        'address_key',
        'role',
        'account',
        'customer_id',
        'hot_wallet_id',
      ] as const)
        if (prior[key] !== identity[key])
          throw new ActionRejectedError('Published sweep wallet registry identity is immutable');
      if (data.registryRevision < prior.registry_revision) return;
    }
    if (customer) await this.customer(tx, event, event.customerId);
    await tx.sweepWalletRegistration.upsert({
      where: { wallet_id: data.walletId },
      create: { wallet_id: data.walletId, ...identity, registry_revision: data.registryRevision },
      update: { registry_revision: data.registryRevision },
    });
    const affected = await tx.sweepWork.findMany({
      where: {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        OR: [
          { source_wallet_id: data.walletId },
          { hot_wallet_id: data.walletId },
          { chain: data.chain, network: data.network, state: 'awaiting_hot_wallet' },
        ],
      },
      orderBy: { id: 'asc' },
      take: 100,
    });
    for (const work of affected)
      await this.refreshWork(tx, event, work.source_wallet_id, work.customer_id, {
        chain: work.chain as CanonicalAsset['chain'],
        network: work.network,
        assetId: work.asset_id,
      });
  }

  private validateWallet(wallet: SweepWalletRegistration, event: DepositResult) {
    const asset = event.data.asset;
    if (
      wallet.domain_id !== event.domainId ||
      wallet.reset_epoch !== event.resetEpoch ||
      wallet.role !== 'customer' ||
      wallet.account < 10 ||
      wallet.customer_id !== event.customerId ||
      wallet.chain !== asset.chain ||
      wallet.network !== asset.network
    )
      throw new ActionRejectedError('Accounted deposit does not match its sweep source registry');
  }

  private async projectDeposit(tx: SweepPrisma.TransactionClient, event: DepositResult) {
    const asset = event.data.asset;
    const previous = await tx.sweepDeposit.findUnique({
      where: { deposit_id: event.data.depositId },
    });
    const credit = event.type === 'deposit.credited.v1';
    const walletId = credit ? event.data.walletId : (previous?.wallet_id ?? null);
    const identity = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      customer_id: event.customerId,
      chain: asset.chain,
      network: asset.network,
      asset_id: asset.assetId,
      amount: event.data.amount,
    };
    if (previous) {
      for (const key of Object.keys(identity) as (keyof typeof identity)[])
        if (previous[key] !== identity[key])
          throw new ActionRejectedError('Accounted sweep deposit identity changed');
      if (previous.wallet_id && credit && previous.wallet_id !== walletId)
        throw new ActionRejectedError('Accounted sweep deposit source changed');
    }
    const revisionDigest = digest({ ...identity, type: event.type, data: event.data });
    if (previous && event.revision <= previous.revision) {
      if (event.revision === previous.revision && revisionDigest !== previous.revision_digest)
        throw new ActionRejectedError('Accounted sweep deposit revision content changed');
      return;
    }
    await this.customer(tx, event, event.customerId);
    if (walletId) {
      const registry = await tx.sweepWalletRegistration.findUnique({
        where: { wallet_id: walletId },
      });
      if (registry) this.validateWallet(registry, event);
      const owner = await tx.sweepWork.findFirst({ where: { source_wallet_id: walletId } });
      if (owner && owner.customer_id !== event.customerId)
        throw new ActionRejectedError('Sweep source already belongs to a different customer');
    }
    await tx.sweepDeposit.upsert({
      where: { deposit_id: event.data.depositId },
      create: {
        deposit_id: event.data.depositId,
        ...identity,
        wallet_id: walletId,
        state: credit ? 'credited' : 'reversed',
        revision: event.revision,
        revision_digest: revisionDigest,
      },
      update: {
        wallet_id: walletId,
        state: credit ? 'credited' : 'reversed',
        revision: event.revision,
        revision_digest: revisionDigest,
      },
    });
    if (walletId) await this.refreshWork(tx, event, walletId, event.customerId, asset);
    if (event.type === 'deposit.reversed.v1' && event.data.deficitIncidentId)
      await this.pauseCustomer(tx, event, 'Deposit reversal left a customer deficit');
  }

  private async pauseDomain(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    reason: string,
  ) {
    // Domain review is represented durably even when no customers or work exist yet.
    await tx.sweepDomainGate.upsert({
      where: {
        domain_id_reset_epoch: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      },
      create: { domain_id: event.domainId, reset_epoch: event.resetEpoch, reason },
      update: {},
    });
    await tx.sweepWork.updateMany({
      where: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      data: { state: 'paused_review', reason },
    });
  }

  private async pauseCustomer(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    reason: string,
  ) {
    if (!event.customerId) throw new ActionRejectedError('Customer custody incident has no owner');
    await this.customer(tx, event, event.customerId);
    await tx.sweepCustomer.update({
      where: { customer_id: event.customerId },
      data: { paused: true, pause_reason: reason },
    });
    await tx.sweepWork.updateMany({
      where: {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        customer_id: event.customerId,
      },
      data: { state: 'paused_review', reason },
    });
  }

  private async refreshWork(
    tx: SweepPrisma.TransactionClient,
    event: ExchangeEvent,
    walletId: string,
    customerId: string,
    asset: CanonicalAsset,
  ) {
    const where = {
      domain_id: event.domainId,
      reset_epoch: event.resetEpoch,
      source_wallet_id: walletId,
      chain: asset.chain,
      network: asset.network,
      asset_id: asset.assetId,
    };
    const deposits = await tx.sweepDeposit.findMany({
      where: { ...identityFields(where), wallet_id: walletId, state: 'credited' },
    });
    const observedCreditUnits = deposits
      .reduce((total, row) => total + BigInt(row.amount), 0n)
      .toString();
    const source = await tx.sweepWalletRegistration.findUnique({ where: { wallet_id: walletId } });
    const hot = source?.hot_wallet_id
      ? await tx.sweepWalletRegistration.findUnique({ where: { wallet_id: source.hot_wallet_id } })
      : null;
    const customer = await tx.sweepCustomer.findUniqueOrThrow({
      where: { customer_id: customerId },
    });
    const domainGate = await tx.sweepDomainGate.findUnique({
      where: {
        domain_id_reset_epoch: { domain_id: event.domainId, reset_epoch: event.resetEpoch },
      },
    });
    let state = 'blocked_execution_not_implemented';
    let reason = 'Phase 4 policy, chain balance, and execution reservation checks are required';
    if (this.config.enableNativeSweeps) {
      state = 'eligible';
      reason = 'Awaiting authoritative Wallet balance and fee preparation';
    }
    const sourceMatches =
      source &&
      source.role === 'customer' &&
      source.account >= 10 &&
      source.customer_id === customerId &&
      source.domain_id === event.domainId &&
      source.reset_epoch === event.resetEpoch &&
      source.chain === asset.chain &&
      source.network === asset.network;
    const hotMatches =
      hot &&
      hot.role === 'hot' &&
      hot.account === 0 &&
      hot.domain_id === event.domainId &&
      hot.reset_epoch === event.resetEpoch &&
      hot.chain === asset.chain &&
      hot.network === asset.network;
    if (domainGate || customer.paused) {
      state = 'paused_review';
      reason = domainGate?.reason ?? customer.pause_reason ?? 'Custody review required';
    } else if (source && !sourceMatches) {
      state = 'paused_registry_identity';
      reason = 'Published source registry conflicts with accounted deposit identity';
    } else if (hot && !hotMatches) {
      state = 'paused_registry_identity';
      reason = 'Published hot wallet conflicts with source custody identity';
    } else if (!deposits.length) {
      state = 'no_credited_deposits';
      reason = 'All accounted deposits for this source and asset were reversed';
    } else if (
      asset.assetId !== `token:${asset.chain}:native` ||
      !['ethereum', 'bitcoin', 'solana'].includes(asset.chain)
    ) {
      state = 'deferred_unsupported_asset';
      reason = 'Initial sweeps support native Ethereum, Bitcoin, and Solana assets';
    } else if (!source) {
      state = 'awaiting_registry';
      reason = 'Awaiting durable source wallet registry delivery';
    } else if (!hot) {
      state = 'awaiting_hot_wallet';
      reason = 'Awaiting account 0 hot wallet registry delivery';
    }
    const previous = await tx.sweepWork.findUnique({
      where: { domain_id_reset_epoch_source_wallet_id_chain_network_asset_id: where },
    });
    // Credited units are a wake-up hint, never the amount sent to the signer.
    // Preserve active attempt state while retaining a new residual generation.
    if (previous?.active_operation_id && !state.startsWith('paused_')) {
      state = previous.state;
      reason = previous.reason;
    }
    const data = {
      customer_id: customerId,
      hot_wallet_id: source?.hot_wallet_id ?? null,
      observed_credit_units: observedCreditUnits,
      credited_deposit_count: deposits.length,
      state,
      reason,
    };
    if (previous && previous.customer_id !== customerId)
      throw new ActionRejectedError('Sweep work ownership changed');
    if (
      previous &&
      (Object.keys(data) as (keyof typeof data)[]).every((key) => previous[key] === data[key])
    )
      return;
    const unitsChanged =
      previous &&
      (previous.observed_credit_units !== observedCreditUnits ||
        previous.credited_deposit_count !== deposits.length);
    const work = await tx.sweepWork.upsert({
      where: { domain_id_reset_epoch_source_wallet_id_chain_network_asset_id: where },
      create: { ...where, ...data },
      update: {
        ...data,
        revision: { increment: 1 },
        ...(unitsChanged ? { generation: { increment: 1 } } : {}),
      },
    });
    if (state === 'deferred_unsupported_asset')
      await this.exception(tx, work, null, 'unsupported_asset', reason);
  }
}

function identityFields(work: {
  domain_id: string;
  reset_epoch: string;
  chain: string;
  network: string;
  asset_id: string;
}) {
  return {
    domain_id: work.domain_id,
    reset_epoch: work.reset_epoch,
    chain: work.chain,
    network: work.network,
    asset_id: work.asset_id,
  };
}
