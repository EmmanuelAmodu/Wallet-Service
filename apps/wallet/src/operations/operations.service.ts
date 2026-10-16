import { BitcoinBatchExecutionService } from '../execution/bitcoin-batch-execution.service.js';
import {
  rolloutConfig,
  RolloutSettings,
  closedRollout,
  rolloutAllows,
} from '../../../../packages/shared/src/rollout.config.js';
import {
  NativeSweepPlanner,
  SweepDeferral,
} from '../../../../packages/chain/src/native-sweep-planner.js';
import { Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { retryFailedConsumerJobs } from '../../../../packages/queue/src/consumer-repair.js';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { CustodySnapshotReader } from '../../../../packages/chain/src/custody-snapshot.js';
import { tokenCertificateSchema } from '../../../../packages/shared/src/token-contracts.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import { operationsConfig, OperationsSettings } from '../config/operations.config.js';
import {
  Message,
  MessageAuth,
  QUEUES,
  canonical,
} from '../../../../packages/queue/src/messages.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
  operationMetricSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { executionDigest } from '../../../../packages/shared/src/execution-authorization.js';
import { CustodyExecutionService } from '../execution/execution.service.js';
import { WithdrawalsService } from '../withdrawals/withdrawals.service.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
const command = { commandId: z.uuid(), reason: z.string().min(1).max(1000) };
export const operationsCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('pause-domain') }).strict(),
  z.object({ ...command, action: z.literal('freeze-customer'), customerId: z.uuid() }).strict(),
  z.object({ ...command, action: z.literal('retry-execution'), transactionId: z.uuid() }).strict(),
  z.object({ ...command, action: z.literal('cancel-withdrawal'), withdrawalId: z.uuid() }).strict(),
  z
    .object({
      ...command,
      action: z.literal('review-incident'),
      alertId: z.string().min(1).max(128),
    })
    .strict(),
  ...(['repair', 'reconcile', 'pause-funding', 'resume-funding', 'resume-domain'] as const).map(
    (action) => z.object({ ...command, action: z.literal(action) }).strict(),
  ),
]);
type Command = z.infer<typeof operationsCommandSchema>;
type Metric = z.infer<typeof operationMetricSchema>;
const json = (x: unknown) => x as Prisma.InputJsonValue;
@Injectable()
export class OperationsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private retrying?: Promise<void>;
  constructor(
    private readonly db: WalletPrismaService,
    private readonly rpc: ChainRpcService,
    private readonly auth: MessageAuth,
    @Inject(walletConfig.KEY) private readonly wallet: WalletConfig,
    @Inject(operationsConfig.KEY) private readonly settings: OperationsSettings,
    private readonly execution: CustodyExecutionService,
    private readonly withdrawals: WithdrawalsService,
    @Optional() @InjectQueue(QUEUES.wallet) private readonly queue?: Queue,
    @Optional()
    @Inject(rolloutConfig.KEY)
    private readonly rollout: RolloutSettings = closedRollout,
    @Optional() private readonly batches?: BitcoinBatchExecutionService,
  ) {}

  onModuleInit() {
    if (this.settings.enabled) {
      this.timer = setInterval(() => {
        if (!this.running)
          this.running = this.tick()
            .catch(() => undefined)
            .finally(() => {
              this.running = undefined;
            });
      }, this.settings.intervalMs);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private retryTransport() {
    if (this.queue && !this.retrying)
      this.retrying = retryFailedConsumerJobs(this.queue, this.auth, this.wallet.domainId!)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.retrying = undefined;
        });
  }

  private event(type: string, data: unknown, extra: Record<string, unknown> = {}): ExchangeEvent {
    return exchangeEventSchema.parse({
      schemaVersion: 1,
      resetEpoch: this.auth.resetEpoch,
      domainId: this.wallet.domainId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: null,
      aggregateId: randomUUID(),
      revision: 1,
      type,
      data,
      ...extra,
    });
  }

  async tick() {
    if (!this.wallet.domainId) return;
    const domain = await this.db.custodyDomain.findUnique({ where: { id: this.wallet.domainId } });
    if (!domain || domain.reset_epoch !== this.auth.resetEpoch) return;
    this.retryTransport();
    await this.execution.repairDue();
    await this.batches?.repairDue();
    await this.withdrawals.repairDue();
    const accepted = await this.db.operationsCommand.findMany({
      where: { domain_id: domain.id, reset_epoch: this.auth.resetEpoch, state: 'accepted' },
      orderBy: { sequence: 'asc' },
      take: this.settings.batchSize,
    });
    for (const row of accepted) {
      try {
        await this.command(operationsCommandSchema.parse(row.request));
      } catch {
        /* Audit failure is retained for explicit retry. */
      }
    }
    const stranded = await this.db.custodyExecution.findMany({
      where: { domain_id: domain.id, reset_epoch: this.auth.resetEpoch, retired_at: null },
      take: 100,
    });
    for (const e of stranded) {
      const deliveries = await this.db.outbox.findMany({
        where: {
          published_at: { lt: new Date(Date.now() - this.settings.freshnessMs) },
          queue: { in: [QUEUES.ledger, QUEUES.activity, QUEUES.sweep] },
          payload: { path: ['attemptId'], equals: e.attempt_id },
        },
        take: 100,
      });
      await this.db.outbox.updateMany({
        where: { id: { in: deliveries.map((d) => d.id) } },
        data: { published_at: null, available_at: new Date() },
      });
    }
    const registries = await this.db.exchangeWalletRegistry.findMany({
      where: { domain_id: domain.id, reset_epoch: this.auth.resetEpoch, ledger_status: 'pending' },
      take: 100,
    });
    for (const r of registries)
      await this.db.outbox.updateMany({
        where: {
          payload: { path: ['data', 'walletId'], equals: r.wallet_id },
          queue: { in: [QUEUES.ledger, QUEUES.activity, QUEUES.sweep] },
        },
        data: { published_at: null, available_at: new Date() },
      });
    await this.schedule();
    await this.requestRepair(randomUUID());
    await this.collectMetrics();
    // Republish retained evidence only. Consumer inboxes and immutable intents preserve exact-once financial effects.
    const rows = await this.db.operationsRun.findMany({
      where: {
        domain_id: domain.id,
        reset_epoch: this.auth.resetEpoch,
        state: { in: ['queued', 'observed'] },
        updated_at: { lt: new Date(Date.now() - this.settings.freshnessMs) },
      },
      orderBy: { updated_at: 'asc' },
      take: this.settings.batchSize,
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        await tx.outbox.updateMany({
          where: {
            dedupe_key: row.evidence
              ? `operations-sample:${row.id}`
              : `operations-monitor:${row.id}`,
          },
          data: { published_at: null, available_at: new Date() },
        });
        await tx.operationsRun.update({ where: { id: row.id }, data: { updated_at: new Date() } });
      });
  }

  async schedule(force = false) {
    const domainId = this.wallet.domainId!;
    const wallets = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT w.id FROM wallets w LEFT JOIN LATERAL (SELECT created_at,state FROM operations_runs r WHERE r.wallet_id=w.id AND r.domain_id=${domainId} AND r.reset_epoch=${this.auth.resetEpoch} ORDER BY sequence DESC LIMIT 1) r ON true WHERE w.custody_domain_id=${domainId} AND w.reset_epoch=${this.auth.resetEpoch} AND w.published_at IS NOT NULL AND w.custody_role IN ('hot','management','customer_deposit') AND (r.created_at IS NULL OR ((r.created_at<now()-${this.settings.freshnessMs}*interval '1 millisecond' OR ${force}) AND r.state NOT IN ('queued','observed'))) ORDER BY r.created_at ASC NULLS FIRST,w.id LIMIT ${this.settings.batchSize}`;
    for (const w of wallets)
      await this.db.$transaction(async (tx) => {
        await lock(tx, `operations-monitor:${w.id}`);
        const prior = await tx.operationsRun.findFirst({
          where: { wallet_id: w.id, domain_id: domainId, reset_epoch: this.auth.resetEpoch },
          orderBy: { sequence: 'desc' },
        });
        if (
          prior &&
          (prior.state === 'queued' ||
            prior.state === 'observed' ||
            (!force && prior.created_at.getTime() > Date.now() - this.settings.freshnessMs))
        )
          return;
        const run = await tx.operationsRun.create({
          data: {
            id: randomUUID(),
            domain_id: domainId,
            reset_epoch: this.auth.resetEpoch,
            wallet_id: w.id,
            state: 'queued',
          },
        });
        await enqueue(
          tx,
          QUEUES.wallet,
          this.event('operations.wallet.sample.requested.v1', { runId: run.id, walletId: w.id }),
          `operations-monitor:${run.id}`,
        );
      });
    return wallets.length;
  }

  async handle(message: Message): Promise<boolean> {
    if (!message.type.startsWith('operations.')) return false;
    if (
      !('domainId' in message) ||
      message.domainId !== this.wallet.domainId ||
      !('resetEpoch' in message) ||
      message.resetEpoch !== this.auth.resetEpoch
    )
      throw new ActionRejectedError('Operations scope or epoch mismatch');
    if (message.type === 'operations.wallet.sample.requested.v1') {
      await this.sample(message);
      return true;
    }
    if (message.type === 'operations.domain.resume.responded.v1') {
      await this.db.$transaction(async (tx) => {
        await lock(tx, `operations-command:${message.data.commandId}`);
        const command = await tx.operationsCommand.findUniqueOrThrow({
          where: { id: message.data.commandId },
        });
        if (
          command.domain_id !== message.domainId ||
          command.reset_epoch !== message.resetEpoch ||
          (command.request as unknown as Command).action !== 'resume-domain'
        )
          throw new ActionRejectedError('Domain recovery has no matching operator command');
        if (command.state === 'completed' || command.state === 'failed') return;
        if (!message.data.accepted) {
          await tx.operationsCommand.update({
            where: { id: command.id },
            data: { state: 'failed', result: json(message.data) },
          });
          return;
        }
        await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${message.domainId} FOR UPDATE`;
        if (
          await tx.operationsCommand.count({
            where: {
              domain_id: message.domainId,
              reset_epoch: message.resetEpoch,
              sequence: { gt: command.sequence },
              request: { path: ['action'], equals: 'pause-domain' },
            },
          })
        ) {
          await tx.operationsCommand.update({
            where: { id: command.id },
            data: {
              state: 'failed',
              result: {
                accepted: false,
                reason: 'A newer quarantine command superseded domain recovery',
              },
            },
          });
          return;
        }
        if (
          await tx.custodyExecution.count({
            where: { domain_id: message.domainId, reset_epoch: message.resetEpoch, reversed: true },
          })
        ) {
          await tx.operationsCommand.update({
            where: { id: command.id },
            data: {
              state: 'failed',
              result: {
                accepted: false,
                reason: 'Canonical reorg recovery must finish before domain activation',
              },
            },
          });
          return;
        }
        const alerts = await tx.operationsAlert.count({
          where: {
            domain_id: message.domainId,
            reset_epoch: message.resetEpoch,
            state: 'open',
            severity: 'critical',
            review: { equals: Prisma.DbNull },
          },
        });
        if (alerts) {
          await tx.operationsCommand.update({
            where: { id: command.id },
            data: {
              state: 'failed',
              result: { accepted: false, reason: 'New critical alerts prevent domain recovery' },
            },
          });
          return;
        }
        await tx.custodyDomain.update({
          where: { id: message.domainId },
          data: { status: 'active' },
        });
        await tx.operationsCommand.update({
          where: { id: command.id },
          data: { state: 'completed', result: json(message.data) },
        });
        const request = (command.result as unknown as { request: ExchangeEvent })?.request;
        if (!request || request.type !== 'operations.domain.resume.requested.v1')
          throw new ActionRejectedError('Recovery proof missing');
        await enqueue(tx, QUEUES.sweep, request, `operations-domain-resume-sweep:${command.id}`);
      });
      return true;
    }
    if (message.type === 'operations.metrics.reported.v1') {
      await this.storeMetrics(message.data.consumer, message.data.metrics, message.occurredAt);
      return true;
    }
    if (message.type === 'operations.custody.reconciled.v1') {
      await this.db.$transaction(async (tx) => {
        await lock(tx, `operations-run:${message.data.runId}`);
        const row = await tx.operationsRun.findUniqueOrThrow({ where: { id: message.data.runId } });
        if (
          row.domain_id !== message.domainId ||
          row.reset_epoch !== message.resetEpoch ||
          row.wallet_id !== message.data.walletId ||
          !row.evidence
        )
          throw new ActionRejectedError('Reconciliation result has no matching canonical sample');
        if (row.report) {
          if (canonical(row.report) !== canonical(message.data))
            throw new ActionRejectedError('Reconciliation result changed');
          return;
        }
        const assets = (
          row.evidence as unknown as Extract<
            ExchangeEvent,
            { type: 'operations.custody.observed.v1' }
          >
        ).data.observations.map((o) => canonical(o.asset));
        if (
          !assets.every((asset) =>
            message.data.report.wallets.some((r) => canonical(r.asset) === asset),
          )
        )
          throw new ActionRejectedError('Reconciliation report is incomplete');
        await tx.operationsRun.update({
          where: { id: row.id },
          data: { state: message.data.status, report: json(message.data) },
        });
      });
      const metrics: Metric[] = message.data.report.wallets.map((r) => ({
        name: 'custody_difference_units',
        value: r.difference
          ? (BigInt(r.difference) < 0n ? -BigInt(r.difference) : BigInt(r.difference)).toString()
          : '0',
        labels: { wallet: message.data.walletId, asset: r.asset.assetId },
        ...(r.status !== 'matched'
          ? {
              alert: r.status === 'difference' ? ('critical' as const) : ('warning' as const),
              reason: r.reason,
            }
          : {}),
      }));
      const sample = await this.db.operationsRun.findUniqueOrThrow({
          where: { id: message.data.runId },
        }),
        wallet = await this.db.wallet.findUniqueOrThrow({ where: { id: message.data.walletId } });
      for (const observation of (
        sample.evidence as unknown as Extract<
          ExchangeEvent,
          { type: 'operations.custody.observed.v1' }
        >
      ).data.observations)
        if (observation.state === 'observed')
          metrics.push({
            name:
              wallet.custody_role === 'hot'
                ? 'hot_verified_custody_units'
                : wallet.custody_role === 'customer_deposit'
                  ? 'customer_custody_unswept_units'
                  : 'management_verified_custody_units',
            value: observation.units!,
            labels: {
              wallet: wallet.id,
              asset: observation.asset.assetId,
              chain: wallet.chain,
              network: wallet.network,
            },
          });
      for (const row of message.data.report.totals)
        metrics.push(
          {
            name: 'ledger_physical_custody_units',
            value: BigInt(row.physicalCustody) < 0n ? '0' : row.physicalCustody,
            labels: {
              asset: row.asset.assetId,
              chain: row.asset.chain,
              network: row.asset.network,
            },
          },
          {
            name: 'customer_liability_units',
            value: BigInt(row.liabilities) < 0n ? '0' : row.liabilities,
            labels: {
              asset: row.asset.assetId,
              chain: row.asset.chain,
              network: row.asset.network,
            },
          },
          {
            name: 'journal_equation_difference',
            value: (BigInt(row.bookEquation) < 0n
              ? -BigInt(row.bookEquation)
              : BigInt(row.bookEquation)
            ).toString(),
            labels: { asset: row.asset.assetId },
            ...(row.bookEquation !== '0'
              ? {
                  alert: 'critical' as const,
                  reason: 'Journal debit/credit equation does not balance',
                }
              : {}),
          },
        );
      await this.storeMetrics(`custody:${message.data.walletId}`, metrics, message.occurredAt);
      return true;
    }
    if (message.type === 'operations.repair.requested.v1') {
      await this.execution.repairDue();
      await this.batches?.repairDue();
      await this.withdrawals.repairDue();
      return true;
    }
    throw new ActionRejectedError('Unsupported Wallet operations message');
  }

  private async sample(
    event: Extract<ExchangeEvent, { type: 'operations.wallet.sample.requested.v1' }>,
  ) {
    const run = await this.db.operationsRun.findUniqueOrThrow({ where: { id: event.data.runId } });
    if (
      run.wallet_id !== event.data.walletId ||
      run.domain_id !== event.domainId ||
      run.reset_epoch !== event.resetEpoch
    )
      throw new ActionRejectedError('Custody sampling run mismatch');
    if (run.evidence) {
      await this.db.outbox.updateMany({
        where: { dedupe_key: `operations-sample:${run.id}` },
        data: { published_at: null, available_at: new Date() },
      });
      return;
    }
    const wallet = await this.db.wallet.findUniqueOrThrow({ where: { id: run.wallet_id } });
    if (
      !wallet.address ||
      !wallet.published_at ||
      wallet.custody_domain_id !== event.domainId ||
      wallet.reset_epoch !== event.resetEpoch
    )
      throw new ActionRejectedError('Custody sampling wallet mismatch');
    const certificates = (
      await this.db.assetConfiguration.findMany({
        where: {
          domain_id: event.domainId,
          chain: wallet.chain,
          network: wallet.network,
          transfer_certificate: { not: Prisma.DbNull },
        },
      })
    ).map((a) => tokenCertificateSchema.parse(a.transfer_certificate));
    const observations = await new CustodySnapshotReader(this.rpc).read(
      { chain: wallet.chain, network: wallet.network, address: wallet.address },
      certificates,
    );
    if (wallet.chain === 'ethereum' && ['hot', 'management'].includes(wallet.custody_role)) {
      const current = observations.find(
        (o) => o.asset.assetId === 'token:ethereum:native' && o.state === 'observed',
      );
      const prior = await this.db.operationsRun.findFirst({
        where: {
          wallet_id: wallet.id,
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
          sequence: { lt: run.sequence },
          evidence: { not: Prisma.DbNull },
        },
        orderBy: { sequence: 'desc' },
      });
      const old = prior
        ? (
            prior.evidence as unknown as Extract<
              ExchangeEvent,
              { type: 'operations.custody.observed.v1' }
            >
          ).data.observations.find(
            (o) => o.asset.assetId === 'token:ethereum:native' && o.state === 'observed',
          )
        : undefined;
      if (
        current?.nonce !== undefined &&
        old?.nonce !== undefined &&
        BigInt(current.nonce) > BigInt(old.nonce)
      ) {
        const known = await this.db.$queryRaw<
          { nonce: string }[]
        >`SELECT DISTINCT COALESCE(prepared_request#>>'{request,transaction,nonce}',prepared_request#>>'{transaction,nonce}') AS nonce FROM custody_executions WHERE domain_id=${event.domainId} AND reset_epoch=${event.resetEpoch} AND source_wallet_id=${wallet.id}::uuid AND state IN ('confirmed','failed') AND NOT reversed AND (inclusion->>'blockHeight')::numeric<=${current.blockHeight}::numeric AND COALESCE(prepared_request#>>'{request,transaction,nonce}',prepared_request#>>'{transaction,nonce}')::numeric>=${old.nonce}::numeric AND COALESCE(prepared_request#>>'{request,transaction,nonce}',prepared_request#>>'{transaction,nonce}')::numeric<${current.nonce}::numeric`;
        const unknown = BigInt(current.nonce) - BigInt(old.nonce) - BigInt(known.length);
        if (unknown > 0n)
          await this.storeMetrics(
            `nonce:${wallet.id}`,
            [
              {
                name: 'unattributed_nonce_advance',
                value: unknown.toString(),
                labels: { wallet: wallet.id, from_nonce: old.nonce, to_nonce: current.nonce },
                alert: 'critical',
                reason:
                  'Finalized hot/management nonce advanced without matching canonical application execution; inspect external transactions and signing access',
              },
            ],
            new Date().toISOString(),
          );
      }
    }

    if (
      ['bitcoin', 'solana'].includes(wallet.chain) &&
      ['hot', 'management'].includes(wallet.custody_role)
    ) {
      const current = observations.find(
        (o) => o.asset.assetId.endsWith(':native') && o.state === 'observed',
      );
      const prior = await this.db.operationsRun.findFirst({
        where: {
          wallet_id: wallet.id,
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
          sequence: { lt: run.sequence },
          evidence: { not: Prisma.DbNull },
        },
        orderBy: { sequence: 'desc' },
      });
      const old = prior
        ? (
            prior.evidence as unknown as Extract<
              ExchangeEvent,
              { type: 'operations.custody.observed.v1' }
            >
          ).data.observations.find(
            (o) => o.asset.assetId.endsWith(':native') && o.state === 'observed',
          )
        : undefined;
      if (current && old) {
        const added = (current.recentTransactions ?? []).filter(
          (id) => !(old.recentTransactions ?? []).includes(id),
        );
        const known = await this.db.$queryRaw<
          { tx_hash: string }[]
        >`SELECT t.tx_hash FROM transactions t JOIN custody_executions c ON c.transaction_id=t.id WHERE c.domain_id=${event.domainId} AND c.reset_epoch=${event.resetEpoch} AND t.tx_hash=ANY(${added}::text[])`;
        const unknown = added.filter((id) => !known.some((k) => k.tx_hash === id));
        if (unknown.length)
          await this.storeMetrics(
            `history:${wallet.id}`,
            [
              {
                name: 'unattributed_custody_activity',
                value: String(unknown.length),
                labels: { wallet: wallet.id, chain: wallet.chain },
                alert: 'warning',
                reason:
                  'New finalized root-address activity outside recorded execution; inspect external funding/outflows before accounting corrections',
              },
            ],
            new Date().toISOString(),
          );
        if (
          wallet.chain === 'solana' &&
          old.recentTransactions?.length &&
          current.recentTransactions?.length === 100 &&
          !current.recentTransactions.includes(old.recentTransactions[0])
        )
          await this.storeMetrics(
            `history-gap:${wallet.id}`,
            [
              {
                name: 'custody_history_gap',
                value: '1',
                labels: { wallet: wallet.id },
                alert: 'warning',
                reason:
                  'Root activity exceeded the bounded signature window; archival backfill and review required',
              },
            ],
            new Date().toISOString(),
          );
      }
    }
    const sample = this.event('operations.custody.observed.v1', {
      runId: run.id,
      sampleSequence: run.sequence.toString(),
      walletId: wallet.id,
      registryRevision: wallet.registry_revision,
      address: wallet.address,
      role: wallet.custody_role,
      observations,
    });
    await this.db.$transaction(async (tx) => {
      await lock(tx, `operations-run:${run.id}`);
      const current = await tx.operationsRun.findUniqueOrThrow({ where: { id: run.id } });
      if (current.evidence) return;
      await tx.operationsRun.update({
        where: { id: run.id },
        data: { state: 'observed', evidence: json(sample) },
      });
      await enqueue(tx, QUEUES.ledger, sample, `operations-sample:${run.id}`);
    });
  }

  private async requestRepair(commandId: string) {
    await this.db.$transaction(async (tx) => {
      const event = this.event('operations.repair.requested.v1', { commandId });
      for (const queue of [QUEUES.ledger, QUEUES.sweep, QUEUES.activity, QUEUES.broadcast])
        await enqueue(tx, queue, event, `operations-repair:${commandId}:${queue}`);
    });
  }

  async command(input: Command) {
    const request = operationsCommandSchema.parse(input),
      domainId = this.wallet.domainId!,
      digest = executionDigest(request);
    await this.db.$transaction(async (tx) => {
      await lock(tx, `operations-command:${request.commandId}`);
      const prior = await tx.operationsCommand.findUnique({ where: { id: request.commandId } });
      if (prior) {
        if (
          prior.digest !== digest ||
          prior.domain_id !== domainId ||
          prior.reset_epoch !== this.auth.resetEpoch
        )
          throw new ConflictException('Command idempotency conflict');
        return;
      }
      const domain = await tx.custodyDomain.findUnique({ where: { id: domainId } });
      if (!domain || domain.reset_epoch !== this.auth.resetEpoch)
        throw new ConflictException('Custody generation unavailable');
      await tx.operationsCommand.create({
        data: {
          id: request.commandId,
          domain_id: domainId,
          reset_epoch: this.auth.resetEpoch,
          actor: this.settings.actor,
          reason: request.reason,
          digest,
          request: json(request),
          state: 'accepted',
        },
      });
    });
    // External work is recoverable under the immutable accepted command; never hold a DB transaction across RPC.
    const stored = await this.db.operationsCommand.findUniqueOrThrow({
      where: { id: request.commandId },
    });
    if (stored.state === 'completed') return { ...stored, sequence: stored.sequence.toString() };
    if (request.action === 'resume-domain' && stored.state === 'failed')
      throw new ConflictException(
        'Rejected domain recovery requires a new command ID and fresh evidence',
      );
    try {
      if (request.action === 'retry-execution') {
        const e = await this.db.custodyExecution.findUnique({
          where: { transaction_id: request.transactionId },
        });
        if (e) {
          if (e.domain_id !== domainId || e.reset_epoch !== this.auth.resetEpoch)
            throw new NotFoundException('Execution not found');
          await this.execution.retrySigned(e.transaction_id, request.commandId);
        } else {
          const batch = await this.db.bitcoinBatchExecution.findFirst({
            where: {
              batch_id: request.transactionId,
              preparation: { batch: { domain_id: domainId, reset_epoch: this.auth.resetEpoch } },
            },
          });
          if (!batch || !this.batches) throw new NotFoundException('Execution not found');
          await this.batches.retrySigned(batch.batch_id, request.commandId);
        }
      } else if (request.action === 'cancel-withdrawal') {
        const w = await this.db.withdrawal.findUnique({ where: { id: request.withdrawalId } });
        if (!w || w.domain_id !== domainId || w.reset_epoch !== this.auth.resetEpoch)
          throw new NotFoundException('Withdrawal not found');
        await this.withdrawals.cancel(w.customer_id, w.id);
      } else if (request.action === 'resume-domain') {
        await this.db.$transaction(async (tx) => {
          await lock(tx, `operations-command:${request.commandId}`);
          const command = await tx.operationsCommand.findUniqueOrThrow({
            where: { id: request.commandId },
          });
          if (command.state === 'awaiting-ledger' || command.state === 'completed') return;
          if (command.state === 'failed')
            throw new ConflictException(
              'Rejected domain recovery requires a new command ID and fresh evidence',
            );
          if (
            await tx.operationsAlert.count({
              where: {
                domain_id: domainId,
                reset_epoch: this.auth.resetEpoch,
                state: 'open',
                severity: 'critical',
                review: { equals: Prisma.DbNull },
              },
            })
          )
            throw new ConflictException('Review critical alerts before domain recovery');
          const wallets = await tx.wallet.findMany({
            where: {
              custody_domain_id: domainId,
              reset_epoch: this.auth.resetEpoch,
              published_at: { not: null },
              custody_role: { in: ['hot', 'management', 'customer_deposit'] },
            },
          });
          const runs = [];
          for (const wallet of wallets) {
            const run = await tx.operationsRun.findFirst({
              where: {
                wallet_id: wallet.id,
                domain_id: domainId,
                reset_epoch: this.auth.resetEpoch,
              },
              orderBy: { sequence: 'desc' },
            });
            if (
              !run ||
              !run.report ||
              run.created_at.getTime() < Date.now() - this.settings.freshnessMs
            )
              throw new ConflictException('Every published wallet needs a fresh reconciled sample');
            const data = run.report as unknown as Extract<
              ExchangeEvent,
              { type: 'operations.custody.reconciled.v1' }
            >['data'];
            if (
              data.report.wallets.some(
                (r) =>
                  r.status === 'unavailable' ||
                  BigInt(r.book) < 0n ||
                  BigInt(r.difference ?? '0') < 0n,
              ) ||
              data.report.totals.some(
                (t) => t.bookEquation !== '0' || BigInt(t.accounts.deficit ?? '0') !== 0n,
              )
            )
              throw new ConflictException(
                'Unresolved custody shortage, deficit or unknown evidence blocks domain recovery',
              );
            runs.push(run.id);
          }
          if (!runs.length) throw new ConflictException('No published custody evidence');
          const event = this.event('operations.domain.resume.requested.v1', {
            commandId: request.commandId,
            runIds: runs,
          });
          await tx.operationsCommand.update({
            where: { id: command.id },
            data: { state: 'awaiting-ledger', result: json({ request: event }) },
          });
          await enqueue(tx, QUEUES.ledger, event, `operations-domain-resume:${request.commandId}`);
        });
        return this.db.operationsCommand
          .findUniqueOrThrow({ where: { id: request.commandId } })
          .then((r) => ({ ...r, sequence: r.sequence.toString() }));
      } else if (request.action === 'reconcile') await this.schedule(true);
      else if (request.action === 'repair') {
        this.retryTransport();
        await this.execution.repairDue();
        await this.batches?.repairDue();
        await this.withdrawals.repairDue();
        await this.requestRepair(request.commandId);
      } else
        await this.db.$transaction(async (tx) => {
          await lock(tx, `operations-command:${request.commandId}`);
          const c = await tx.operationsCommand.findUniqueOrThrow({
            where: { id: request.commandId },
          });
          if (c.state === 'completed') return;
          if (request.action === 'pause-domain') {
            await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${domainId} FOR UPDATE`;
            await tx.custodyDomain.update({ where: { id: domainId }, data: { status: 'paused' } });
            const incident = this.event('custody.incident.opened.v1', {
              incidentId: request.commandId,
              severity: 'critical',
              category: 'operator_quarantine',
              status: 'open',
              reason: request.reason,
            });
            for (const queue of [QUEUES.sweep, QUEUES.ledger])
              await enqueue(
                tx,
                queue,
                incident,
                `operations-quarantine:${request.commandId}:${queue}`,
              );
          } else if (request.action === 'freeze-customer') {
            await tx.$queryRaw`SELECT customer_id FROM exchange_customers WHERE customer_id=${request.customerId}::uuid FOR UPDATE`;
            const customer = await tx.exchangeCustomer.findUnique({
              where: { customer_id: request.customerId },
            });
            if (
              !customer ||
              customer.domain_id !== domainId ||
              customer.reset_epoch !== this.auth.resetEpoch
            )
              throw new NotFoundException('Customer not found');
            await tx.exchangeCustomer.update({
              where: { customer_id: customer.customer_id },
              data: { state: 'frozen' },
            });
            const incident = this.event(
              'custody.incident.opened.v1',
              {
                incidentId: request.commandId,
                severity: 'critical',
                category: 'operator_freeze',
                status: 'open',
                reason: request.reason,
              },
              { customerId: customer.customer_id },
            );
            for (const queue of [QUEUES.sweep, QUEUES.ledger])
              await enqueue(tx, queue, incident, `operations-freeze:${request.commandId}:${queue}`);
          } else if (request.action === 'pause-funding' || request.action === 'resume-funding') {
            await lock(tx, `management-funding:${domainId}:${this.auth.resetEpoch}`);
            await tx.operationsFundingGate.upsert({
              where: {
                domain_id_reset_epoch: { domain_id: domainId, reset_epoch: this.auth.resetEpoch },
              },
              create: {
                domain_id: domainId,
                reset_epoch: this.auth.resetEpoch,
                enabled: request.action === 'resume-funding',
                reason: request.reason,
              },
              update: { enabled: request.action === 'resume-funding', reason: request.reason },
            });
          } else if (request.action === 'review-incident') {
            const alert = await tx.operationsAlert.findUnique({ where: { id: request.alertId } });
            if (
              !alert ||
              alert.domain_id !== domainId ||
              alert.reset_epoch !== this.auth.resetEpoch
            )
              throw new NotFoundException('Alert not found');
            await tx.operationsAlert.update({
              where: { id: alert.id },
              data: {
                review: json({
                  commandId: request.commandId,
                  actor: this.settings.actor,
                  reason: request.reason,
                  at: new Date().toISOString(),
                }),
              },
            });
          }
          await tx.operationsCommand.update({
            where: { id: request.commandId },
            data: { state: 'completed', result: { action: request.action } },
          });
        });
      await this.db.operationsCommand.updateMany({
        where: { id: request.commandId, state: { not: 'completed' } },
        data: { state: 'completed', result: { action: request.action } },
      });
    } catch (error) {
      await this.db.operationsCommand.updateMany({
        where: { id: request.commandId, state: { not: 'completed' } },
        data: {
          state: 'failed',
          result: {
            reason:
              error instanceof ConflictException || error instanceof NotFoundException
                ? error.message
                : 'Operational recovery failed; retained evidence can be retried',
          },
        },
      });
      throw error;
    }
    return this.db.operationsCommand
      .findUniqueOrThrow({ where: { id: request.commandId } })
      .then((r) => ({ ...r, sequence: r.sequence.toString() }));
  }

  async storeMetrics(consumer: string, metrics: Metric[], occurredAt: string) {
    metrics.forEach((m) => operationMetricSchema.parse(m));
    const domainId = this.wallet.domainId!,
      epoch = this.auth.resetEpoch,
      reportId = executionDigest([domainId, epoch, consumer]);
    await this.db.$transaction(async (tx) => {
      await lock(tx, `operations-metrics:${reportId}`);
      const prior = await tx.operationsMetricReport.findUnique({ where: { id: reportId } });
      if (prior && prior.occurred_at > new Date(occurredAt)) return;
      await tx.operationsMetricReport.upsert({
        where: { id: reportId },
        create: {
          id: reportId,
          domain_id: domainId,
          reset_epoch: epoch,
          consumer,
          occurred_at: new Date(occurredAt),
          metrics: json(metrics),
        },
        update: { occurred_at: new Date(occurredAt), metrics: json(metrics) },
      });
      const active: string[] = [];
      for (const metric of metrics) {
        if (!metric.alert) continue;
        const id = executionDigest([domainId, epoch, consumer, metric.name, metric.labels]);
        active.push(id);
        await tx.operationsAlert.upsert({
          where: { id },
          create: {
            id,
            domain_id: domainId,
            reset_epoch: epoch,
            severity: metric.alert,
            state: 'open',
            evidence: json({ consumer, metric }),
          },
          update: {
            severity: metric.alert,
            state: 'open',
            evidence: json({ consumer, metric }),
            last_seen_at: new Date(),
          },
        });
      }
      await tx.operationsAlert.updateMany({
        where: {
          domain_id: domainId,
          reset_epoch: epoch,
          id: { notIn: active },
          evidence: { path: ['consumer'], equals: consumer },
          state: 'open',
        },
        data: { state: 'resolved', last_seen_at: new Date() },
      });
    });
  }

  async preview() {
    const scope = {
      custody_domain_id: this.wallet.domainId!,
      reset_epoch: this.auth.resetEpoch,
      active: true,
    };
    const wallets = await this.db.wallet.findMany({
      where: {
        ...scope,
        custody_role: 'customer_deposit',
        status: 'ready',
        address: { not: null },
      },
      orderBy: { id: 'asc' },
      take: this.settings.batchSize,
    });
    const hot = await this.db.wallet.findMany({
      where: { ...scope, custody_role: 'hot', account: 0, status: 'ready', address: { not: null } },
    });
    const planner = new NativeSweepPlanner(this.rpc),
      plans = [];
    for (const wallet of wallets) {
      const target = hot.find((h) => h.chain === wallet.chain && h.network === wallet.network);
      if (!target) {
        plans.push({
          walletId: wallet.id,
          state: 'unavailable',
          reason: 'Registered hot wallet unavailable',
        });
        continue;
      }
      try {
        const plan = await planner.plan({
          chain: wallet.chain as 'ethereum' | 'bitcoin' | 'solana',
          network: wallet.network,
          sourceAddress: wallet.address!,
          hotAddress: target.address!,
        });
        plans.push({
          walletId: wallet.id,
          chain: wallet.chain,
          network: wallet.network,
          state: 'preview',
          principalUnits: plan.amount,
          maximumFeeUnits: plan.maxFeeUnits,
          resourceKeys: plan.resourceKeys,
          dispatchAllowed: rolloutAllows(this.rollout, 'sweeps', {
            domainId: this.wallet.domainId!,
            chain: wallet.chain,
            network: wallet.network,
          }),
        });
      } catch (error) {
        plans.push({
          walletId: wallet.id,
          state: error instanceof SweepDeferral ? error.code : 'unavailable',
          reason: error instanceof SweepDeferral ? error.message : 'Canonical planning unavailable',
        });
      }
    }
    return {
      mode: this.rollout.mode,
      sampledAt: new Date().toISOString(),
      readOnly: true,
      scope: 'bounded native sweep planning; no token drain ordering or execution authorization',
      limit: this.settings.batchSize,
      plans,
    };
  }

  async collectMetrics() {
    const scope = { domain_id: this.wallet.domainId!, reset_epoch: this.auth.resetEpoch };
    const executions = await this.db.custodyExecution.findMany({
        where: { ...scope, retired_at: null },
      }),
      withdrawals = await this.db.withdrawal.findMany({
        where: { ...scope, state: { notIn: ['settled', 'failed', 'cancelled', 'rejected'] } },
      });
    const oldest = withdrawals.length
      ? Math.max(...withdrawals.map((w) => Date.now() - w.created_at.getTime()))
      : 0;
    const metrics: Metric[] = [
      { name: 'withdrawal_backlog', value: String(withdrawals.length), labels: {} },
      {
        name: 'withdrawal_oldest_age_ms',
        value: String(Math.max(0, oldest)),
        labels: {},
        ...(oldest > this.settings.freshnessMs
          ? { alert: 'warning', reason: 'Withdrawal backlog exceeds recovery threshold' }
          : {}),
      },
      {
        name: 'active_execution_claims',
        value: String(
          await this.db.executionResourceClaim.count({
            where: {
              active: true,
              execution: { domain_id: this.wallet.domainId!, reset_epoch: this.auth.resetEpoch },
            },
          }),
        ),
        labels: {},
      },
      {
        name: 'reorg_exposure',
        value: String(executions.filter((e) => e.reversed).length),
        labels: {},
        ...(executions.some((e) => e.reversed)
          ? { alert: 'critical', reason: 'Reversed custody execution retains resources' }
          : {}),
      },
      {
        name: 'registry_lag',
        value: String(
          await this.db.exchangeWalletRegistry.count({
            where: { ...scope, role: 'customer_deposit', ready: false },
          }),
        ),
        labels: {},
      },
      {
        name: 'gas_dependencies',
        value: String(
          await this.db.tokenFeeReservation.count({
            where: { ...scope, state: { in: ['reserved', 'uncertain', 'reverted'] } },
          }),
        ),
        labels: {},
      },
    ];
    const reports = await this.db.operationsMetricReport.findMany({ where: scope });
    const batchScope = { preparation: { batch: scope } };
    const batchBacklog = await this.db.bitcoinBatchExecution.count({
      where: { ...batchScope, state: { not: 'settled' } },
    });
    const batchReorgs = await this.db.bitcoinBatchExecution.count({
      where: { ...batchScope, state: 'reverted' },
    });
    const oldestBatch = await this.db.bitcoinBatchExecution.findFirst({
      where: { ...batchScope, state: { not: 'settled' } },
      orderBy: { created_at: 'asc' },
    });
    const batchAge = oldestBatch ? Math.max(0, Date.now() - oldestBatch.created_at.getTime()) : 0;
    metrics.push(
      { name: 'bitcoin_batch_backlog', value: String(batchBacklog), labels: {} },
      {
        name: 'bitcoin_batch_oldest_age_ms',
        value: String(batchAge),
        labels: {},
        ...(batchAge > this.settings.freshnessMs
          ? {
              alert: 'warning' as const,
              reason: 'Batch execution requires reconciliation or original-message repair',
            }
          : {}),
      },
      {
        name: 'bitcoin_batch_reorg_exposure',
        value: String(batchReorgs),
        labels: {},
        ...(batchReorgs
          ? {
              alert: 'critical' as const,
              reason: 'Reversed batch retains original customer obligations',
            }
          : {}),
      },
      {
        name: 'bitcoin_retained_outpoint_owners',
        value: String(
          await this.db.withdrawalBatchResource.count({
            where: { active: true, preparation: { batch: scope } },
          }),
        ),
        labels: {},
      },
    );
    for (const consumer of ['ledger', 'sweep', 'activity-listener', 'broadcast']) {
      const report = reports.find((r) => r.consumer === consumer),
        age = report
          ? Math.max(0, Date.now() - report.occurred_at.getTime())
          : this.settings.freshnessMs + 1;
      metrics.push({
        name: 'consumer_report_age_ms',
        value: String(age),
        labels: { consumer },
        ...(age > this.settings.freshnessMs
          ? {
              alert: 'warning' as const,
              reason: 'Operational consumer heartbeat is missing or stale',
            }
          : {}),
      });
    }
    const pending = await this.db.outbox.findFirst({
      where: { published_at: null, available_at: { lte: new Date() } },
      orderBy: { available_at: 'asc' },
    });
    const age = pending ? Math.max(0, Date.now() - pending.available_at.getTime()) : 0;
    metrics.push({
      name: 'outbox_oldest_delivery_age_ms',
      value: String(age),
      labels: {},
      ...(age > this.settings.freshnessMs
        ? {
            alert: 'warning' as const,
            reason: 'Committed deliveries are stalled; inspect Redis/outbox workers',
          }
        : {}),
    });
    for (const e of executions) {
      const source = await this.db.wallet.findUnique({ where: { id: e.source_wallet_id } });
      if (source?.custody_role !== 'hot') continue;
      const plan = e.plan as { data: { asset: { assetId: string } } };
      metrics.push({
        name: 'hot_execution_principal_reserved_units',
        value: e.principal_units ?? '0',
        labels: { wallet: source.id, asset: plan.data.asset.assetId },
      });
      metrics.push({
        name: 'hot_execution_native_cost_reserved_units',
        value: e.maximum_fee_units ?? '0',
        labels: { wallet: source.id, asset: `token:${source.chain}:native` },
      });
    }
    await this.storeMetrics('wallet', metrics, new Date().toISOString());
    return metrics;
  }

  async batch(batchId: string) {
    if (!this.batches) throw new NotFoundException('Batch operations unavailable');
    return this.batches.inspect(batchId);
  }

  async attempts(transactionId: string, cursor?: string, limit = 50) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined &&
        (!/^[1-9][0-9]{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n))
    )
      throw new BadRequestException('Invalid attempt history pagination');
    const execution = await this.db.custodyExecution.findFirst({
      where: {
        transaction_id: transactionId,
        domain_id: this.wallet.domainId!,
        reset_epoch: this.auth.resetEpoch,
      },
    });
    if (!execution) throw new NotFoundException('Custody execution not found');
    const attempts = await this.db.custodyAttempt.findMany({
      where: {
        execution_id: execution.id,
        domain_id: this.wallet.domainId!,
        reset_epoch: this.auth.resetEpoch,
      },
      orderBy: { ordinal: 'asc' },
    });
    const ids = attempts.map((a) => a.id);
    if (
      cursor &&
      !(await this.db.custodyAttemptObservation.findFirst({
        where: { attempt_id: { in: ids }, sequence: BigInt(cursor) },
        select: { id: true },
      }))
    )
      throw new BadRequestException('Attempt history cursor belongs to another execution');
    const rows = await this.db.custodyAttemptObservation.findMany({
      where: { attempt_id: { in: ids }, ...(cursor ? { sequence: { gt: BigInt(cursor) } } : {}) },
      orderBy: { sequence: 'asc' },
      take: limit + 1,
    });
    const observations = rows.slice(0, limit);
    return {
      transactionId,
      operationId: execution.operation_id,
      replacementEnabled: false,
      attempts,
      observations: observations.map((o) => ({ ...o, sequence: o.sequence.toString() })),
      nextCursor: rows.length > limit ? observations.at(-1)!.sequence.toString() : null,
    };
  }

  async status() {
    const scope = { domain_id: this.wallet.domainId!, reset_epoch: this.auth.resetEpoch };
    return {
      rollout: this.rollout,
      domainId: this.wallet.domainId,
      resetEpoch: this.auth.resetEpoch,
      runs: (
        await this.db.operationsRun.findMany({
          where: scope,
          orderBy: { sequence: 'desc' },
          take: 100,
        })
      ).map((r) => ({ ...r, sequence: r.sequence.toString() })),
      alerts: await this.db.operationsAlert.findMany({
        where: scope,
        orderBy: { last_seen_at: 'desc' },
        take: 100,
      }),
      commands: (
        await this.db.operationsCommand.findMany({
          where: scope,
          orderBy: { sequence: 'desc' },
          take: 100,
        })
      ).map((c) => ({ ...c, sequence: c.sequence.toString() })),
    };
  }

  async metrics() {
    return this.db.operationsMetricReport.findMany({
      where: { domain_id: this.wallet.domainId!, reset_epoch: this.auth.resetEpoch },
    });
  }
}
