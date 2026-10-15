import {
  rolloutConfig,
  RolloutSettings,
  closedRollout,
  rolloutAllows,
} from '../../../../packages/shared/src/rollout.config.js';
import { assertManagementFundingEnabled } from '../operations/funding-gate.js';
import { TokenFeesService } from './token-fees.service.js';
import { EvmLiquidityService } from './evm-liquidity.service.js';
import { Optional, Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CustodyExecution, Prisma, Wallet } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { TokenPlanner, TokenPreparation } from '../../../../packages/chain/src/token-planner.js';
import { TokenObserver } from '../../../../packages/chain/src/token-observer.js';
import {
  TokenSignRequest,
  tokenCertificateSchema,
  tokenPreparationSchema,
  tokenAsset,
} from '../../../../packages/shared/src/token-contracts.js';
import { signTokenExecutionAuthorization } from '../../../../packages/shared/src/token-authorization.js';
import {
  NativeSweepPlanner,
  SweepDeferral,
} from '../../../../packages/chain/src/native-sweep-planner.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import {
  Message,
  MessageAuth,
  QUEUES,
  canonical,
  messageSchema,
} from '../../../../packages/queue/src/messages.js';
import { enqueue, enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import {
  SignRequest,
  signSchema,
  signedSchema,
} from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  nativeExecutionAssetSchema,
  executionDigest,
  executionRequestDigest,
  signExecutionAuthorization,
  verifySignerAttestation,
} from '../../../../packages/shared/src/execution-authorization.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { CustodyService } from '../custody/custody.service.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import { executionConfig, ExecutionSettings } from '../config/execution.config.js';

type Plan = Extract<
  ExchangeEvent,
  { type: 'sweep.plan.requested.v1' | 'withdrawal.plan.requested.v1' | 'funding.plan.requested.v1' }
>;
type Execute = Extract<
  ExchangeEvent,
  {
    type:
      | 'sweep.execute.requested.v1'
      | 'withdrawal.execute.requested.v1'
      | 'funding.execute.requested.v1';
  }
>;
type Result = Extract<
  Message,
  { type: 'transaction.custody.signed' | 'transaction.custody.rejected' }
>;
const json = (value: unknown) => value as Prisma.InputJsonValue;

function eventId(value: unknown) {
  const hex = executionDigest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

@Injectable()
export class CustodyExecutionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: WalletPrismaService,
    private readonly custody: CustodyService,
    private readonly rpc: ChainRpcService,
    @Inject(walletConfig.KEY) private readonly walletConfig: WalletConfig,
    @Inject(executionConfig.KEY) private readonly config: ExecutionSettings,
    private readonly auth: MessageAuth,
    @Optional()
    @Inject(rolloutConfig.KEY)
    private readonly rollout: RolloutSettings = closedRollout,
    @Optional() private readonly liquidity?: EvmLiquidityService,
  ) {}

  private get planner() {
    return new NativeSweepPlanner(this.rpc);
  }

  private tokenPreparation(execution: CustodyExecution): TokenPreparation | undefined {
    const value = execution.prepared_request;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'certificate' in value)
      return tokenPreparationSchema.parse(value) as TokenPreparation;
    return undefined;
  }

  private request(execution: CustodyExecution): SignRequest | TokenSignRequest {
    return (
      this.tokenPreparation(execution)?.request ?? signSchema.parse(execution.prepared_request)
    );
  }

  private async tokenAuthority(tx: Prisma.TransactionClient, plan: Plan) {
    const configuration = await tx.assetConfiguration.findUniqueOrThrow({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: plan.domainId,
          chain: plan.data.asset.chain,
          network: plan.data.asset.network,
          asset_id: plan.data.asset.assetId,
        },
      },
    });
    if (!this.config.tokensEnabled || !configuration.transfer_certificate)
      throw new SweepDeferral('disabled', 'Certified token execution is disabled');
    const certificate = tokenCertificateSchema.parse(configuration.transfer_certificate);
    if (
      canonical(tokenAsset(certificate)) !== canonical(plan.data.asset) ||
      configuration.decimals !== certificate.decimals ||
      configuration.standard !== certificate.standard
    )
      throw new ActionRejectedError('Token certificate metadata mismatch');
    if (plan.type === 'sweep.plan.requested.v1') {
      if (certificate.standard === 'spl')
        await assertManagementFundingEnabled(tx, plan.domainId, plan.resetEpoch);
      const coverage = await tx.tokenWalletCoverage.findUnique({
        where: {
          wallet_id_asset_id: {
            wallet_id: plan.data.sourceWalletId,
            asset_id: plan.data.asset.assetId,
          },
        },
      });
      if (
        !coverage?.ready ||
        coverage.domain_id !== plan.domainId ||
        coverage.reset_epoch !== plan.resetEpoch ||
        coverage.registry_revision !== plan.data.sourceRegistryRevision ||
        coverage.configuration_revision !== configuration.configuration_revision ||
        coverage.certificate_digest !== executionDigest(certificate)
      )
        throw new SweepDeferral(
          'paused_review',
          'Token-specific address watch and historical coverage is not ready',
        );
    }
    let sponsor: Wallet | undefined;
    if (certificate.standard === 'spl' && plan.type === 'sweep.plan.requested.v1') {
      const payer = await tx.wallet.findFirst({
        where: {
          custody_domain_id: plan.domainId,
          reset_epoch: plan.resetEpoch,
          chain: 'solana',
          network: certificate.network,
          custody_role: 'management',
          account: 1,
          active: true,
        },
      });
      if (
        !payer ||
        !payer.address ||
        !payer.published_at ||
        !(await this.custody.publicationAllowed(tx, payer))
      )
        throw new SweepDeferral('paused_review', 'Management1 sponsor is not ready');
      const registry = await tx.exchangeWalletRegistry.findUnique({
        where: { wallet_id: payer.id },
      });
      if (
        registry?.ledger_status !== 'ready' ||
        registry.registry_revision !== payer.registry_revision ||
        registry.ledger_ack_revision !== payer.registry_revision
      )
        throw new SweepDeferral(
          'paused_review',
          'Management1 sponsor lacks Ledger registry acknowledgment',
        );
      sponsor = payer;
    }
    return { certificate, sponsor };
  }

  onModuleInit() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
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

  async handle(message: Message): Promise<boolean> {
    if (message.type === 'asset.transfer.watch.acknowledged.v1') {
      if (
        message.domainId !== this.walletConfig.domainId ||
        message.resetEpoch !== this.auth.resetEpoch
      )
        throw new ActionRejectedError('Token watch acknowledgment domain or epoch mismatch');
      await this.db.$transaction(async (tx) => {
        await lock(tx, `token-coverage:${message.data.walletId}:${message.data.asset.assetId}`);
        const wallet = await tx.wallet.findUnique({ where: { id: message.data.walletId } }),
          asset = await tx.assetConfiguration.findUnique({
            where: {
              domain_id_chain_network_asset_id: {
                domain_id: message.domainId,
                chain: message.data.asset.chain,
                network: message.data.asset.network,
                asset_id: message.data.asset.assetId,
              },
            },
          });
        if (
          !wallet ||
          wallet.custody_domain_id !== message.domainId ||
          wallet.reset_epoch !== message.resetEpoch ||
          wallet.chain !== message.data.asset.chain ||
          wallet.network !== message.data.asset.network ||
          !asset?.transfer_certificate ||
          executionDigest(asset.transfer_certificate) !== message.data.certificateDigest
        )
          throw new ActionRejectedError(
            'Token watch does not match a registered wallet and certificate',
          );
        if (
          wallet.registry_revision !== message.data.registryRevision ||
          asset.configuration_revision !== message.data.configurationRevision
        )
          return;
        const key = { wallet_id: wallet.id, asset_id: message.data.asset.assetId },
          prior = await tx.tokenWalletCoverage.findUnique({ where: { wallet_id_asset_id: key } });
        if (prior && prior.readiness_revision >= message.revision) {
          if (
            prior.readiness_revision === message.revision &&
            (prior.generation !== message.data.generation ||
              prior.ready !== message.data.ready ||
              prior.cursor !== (message.data.cursor ?? null))
          )
            throw new ActionRejectedError('Token readiness revision conflicts');
          return;
        }
        const data = {
          domain_id: message.domainId,
          reset_epoch: message.resetEpoch,
          certificate_digest: message.data.certificateDigest,
          configuration_revision: message.data.configurationRevision,
          registry_revision: message.data.registryRevision,
          generation: message.data.generation,
          readiness_revision: message.revision,
          ready: message.data.ready,
          cursor: message.data.cursor ?? null,
        };
        await tx.tokenWalletCoverage.upsert({
          where: { wallet_id_asset_id: key },
          create: { ...key, ...data },
          update: data,
        });
      });
      return true;
    }
    if (message.type === 'execution.registry.acknowledged.v1') {
      const execution = await this.db.custodyExecution.findUnique({
        where: { operation_id: message.operationId },
      });
      if (!execution) throw new Error('Execution registration has not arrived');
      this.checkIdentity(execution, message);
      await this.db.custodyExecution.update({
        where: { id: execution.id },
        data: {
          ...(message.data.consumer === 'ledger'
            ? { ledger_intent_ack: true }
            : { listener_intent_ack: true }),
          next_check_at: new Date(),
        },
      });
      await this.reconcile(execution.transaction_id);
      return true;
    }
    if (message.type === 'funding.plan.prepared.v1') {
      const execute = exchangeEventSchema.parse({
        ...message,
        type: 'funding.execute.requested.v1',
        eventId: eventId([message.attemptId, 'funding-execute']),
        causationId: message.eventId,
        data: {
          sourceWalletId: message.data.sourceWalletId,
          destinationWalletId: message.data.destinationWalletId,
          amount: message.data.amount,
          preparationDigest: message.data.preparationDigest,
        },
      });
      if (execute.type === 'funding.execute.requested.v1') await this.execute(execute);
      return true;
    }
    if (message.type === 'funding.plan.deferred.v1') {
      const current = await this.db.custodyExecution.findUnique({
        where: { operation_id: message.operationId },
      });
      if (
        !current ||
        (!current.authorization && current.retired_at && current.state === 'deferred')
      )
        await this.db.tokenFeeReservation.updateMany({
          where: { id: message.operationId, state: 'reserved' },
          data: { state: 'released' },
        });
      return true;
    }
    if (message.type === 'execution.attempt.updated.v1') {
      const current = await this.db.custodyExecution.findUnique({
        where: { operation_id: message.operationId },
      });
      if (current && (current.plan as unknown as Plan).type === 'funding.plan.requested.v1')
        return true;
    }
    if (
      message.type === 'sweep.plan.requested.v1' ||
      message.type === 'withdrawal.plan.requested.v1' ||
      message.type === 'funding.plan.requested.v1'
    ) {
      await this.plan(message);
      return true;
    }
    if (
      message.type === 'sweep.execute.requested.v1' ||
      message.type === 'withdrawal.execute.requested.v1' ||
      message.type === 'funding.execute.requested.v1'
    ) {
      await this.execute(message);
      return true;
    }
    if (
      message.type === 'transaction.custody.signed' ||
      message.type === 'transaction.custody.rejected'
    ) {
      await this.signed(message);
      return true;
    }
    if (message.type === 'execution.reconcile') {
      await this.reconcile(message.transactionId);
      return true;
    }
    if (message.type === 'settlement.committed.v1' || message.type === 'settlement.reversed.v1') {
      const execution = await this.db.custodyExecution.findUnique({
        where: { operation_id: message.operationId },
      });
      if (!execution) return false;
      await this.ledgerResult(message, execution);
      return (execution.plan as unknown as Plan).type !== 'withdrawal.plan.requested.v1';
    }
    if (message.type === 'broadcast.updated') {
      const execution = await this.db.custodyExecution.findUnique({
        where: { transaction_id: message.transactionId },
      });
      if (!execution) return false;
      const binding = message.execution;
      if (
        !binding ||
        binding.operationId !== execution.operation_id ||
        binding.attemptId !== execution.attempt_id ||
        binding.requestDigest !== execution.request_digest ||
        binding.preparationDigest !== execution.preparation_digest
      )
        throw new ActionRejectedError('Broadcast result execution binding mismatch');
      await this.db.$transaction(async (tx) => {
        await lock(tx, `custody-source:${execution.source_wallet_id}`);
        const transaction = await tx.transaction.findUniqueOrThrow({
          where: { id: execution.transaction_id },
        });
        if (
          transaction.broadcast_generation !== message.generation ||
          transaction.broadcast_revision >= message.revision
        )
          return;
        const current = await tx.custodyExecution.findUniqueOrThrow({
          where: { id: execution.id },
        });
        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            broadcast_revision: message.revision,
            broadcast_attempts: message.attempts,
            last_error: message.lastError,
            ...(!current.retired_at &&
            ['queued', 'submitted', 'attention'].includes(current.state) &&
            (message.status === 'submitted' || message.status === 'attention')
              ? { status: message.status }
              : {}),
          },
        });
        if (!current.retired_at && ['queued', 'submitted', 'attention'].includes(current.state)) {
          const next = await tx.custodyExecution.update({
            where: { id: current.id },
            data: {
              ...(message.status === 'submitted' || message.status === 'attention'
                ? { state: message.status }
                : {}),
              revision: { increment: 1 },
              next_check_at: new Date(),
              last_error: message.lastError,
            },
          });
          await this.emitAttempt(tx, next, false);
        }
      });
      await this.reconcile(message.transactionId);
      return true;
    }
    return false;
  }

  private validatePlan(event: Plan) {
    if (
      event.domainId !== this.walletConfig.domainId ||
      event.resetEpoch !== this.auth.resetEpoch ||
      event.policyVersion !== 'exchange-financial-v1'
    )
      throw new ActionRejectedError('Custody execution domain, epoch or policy mismatch');
    const expected = executionDigest({
      domainId: event.domainId,
      resetEpoch: event.resetEpoch,
      customerId: event.customerId,
      operationId: event.operationId,
      attemptId: event.attemptId,
      policyVersion: event.policyVersion,
      data: event.data,
    });
    if (event.type !== 'withdrawal.plan.requested.v1' && event.requestDigest !== expected)
      throw new ActionRejectedError('Sweep planning digest mismatch');
  }

  private async authority(
    tx: Prisma.TransactionClient,
    plan: Plan,
  ): Promise<{ source: Wallet; hot: Wallet }> {
    if (
      !rolloutAllows(
        this.rollout,
        plan.type === 'withdrawal.plan.requested.v1' ? 'withdrawals' : 'sweeps',
        { domainId: plan.domainId, ...plan.data.asset },
      )
    )
      throw new SweepDeferral('disabled', 'Custody authorization paused by rollout policy');
    if (plan.type === 'funding.plan.requested.v1') return this.fundingAuthority(tx, plan);
    if (plan.type === 'withdrawal.plan.requested.v1') return this.withdrawalAuthority(tx, plan);
    if (
      !this.config.enabled ||
      (plan.data.asset.assetId.endsWith(':native')
        ? this.config.sweepsEnabled === false
        : !this.config.tokensEnabled) ||
      !this.config.authorityPrivateKey ||
      !this.config.signerPublicKey
    )
      throw new SweepDeferral('disabled', 'Native sweep execution is disabled');
    // Policy writers use PostgreSQL updates. Lock their rows through authorization/outbox commit.
    await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${plan.domainId} FOR UPDATE`;
    await tx.$queryRaw`SELECT customer_id FROM exchange_customers WHERE customer_id=${plan.customerId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${plan.data.sourceWalletId}::uuid,${plan.data.destinationWalletId}::uuid) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT wallet_id FROM exchange_wallet_registry WHERE wallet_id IN (${plan.data.sourceWalletId}::uuid,${plan.data.destinationWalletId}::uuid) ORDER BY wallet_id FOR UPDATE`;
    await tx.$queryRaw`SELECT domain_id FROM asset_configurations WHERE domain_id=${plan.domainId} AND chain=${plan.data.asset.chain} AND network=${plan.data.asset.network} AND asset_id=${plan.data.asset.assetId} FOR UPDATE`;
    const source = await tx.wallet.findUnique({ where: { id: plan.data.sourceWalletId } });
    const hot = await tx.wallet.findUnique({ where: { id: plan.data.destinationWalletId } });
    if (
      !source ||
      !hot ||
      source.custody_role !== 'customer_deposit' ||
      source.account < 10 ||
      source.customer_id !== plan.customerId ||
      source.hot_wallet_id !== hot.id ||
      hot.custody_role !== 'hot' ||
      hot.account !== 0 ||
      source.seed_id !== hot.seed_id ||
      source.chain !== plan.data.asset.chain ||
      source.network !== plan.data.asset.network ||
      hot.chain !== source.chain ||
      hot.network !== source.network ||
      !source.address ||
      !hot.address ||
      !source.published_at ||
      !hot.published_at ||
      source.registry_revision !== plan.data.sourceRegistryRevision ||
      hot.registry_revision !== plan.data.hotRegistryRevision ||
      !(await this.custody.publicationAllowed(tx, source)) ||
      !(await this.custody.publicationAllowed(tx, hot))
    )
      throw new SweepDeferral('paused_review', 'Custody source or hot authority is not ready');
    const customer = await tx.exchangeCustomer.findUnique({
      where: { customer_id: plan.customerId },
    });
    const registry = await tx.exchangeWalletRegistry.findUnique({
      where: { wallet_id: source.id },
    });
    const hotRegistry = await tx.exchangeWalletRegistry.findUnique({
      where: { wallet_id: hot.id },
    });
    const asset = await tx.assetConfiguration.findUnique({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: plan.domainId,
          chain: source.chain,
          network: source.network,
          asset_id: plan.data.asset.assetId,
        },
      },
    });
    if (
      !customer ||
      customer.domain_id !== plan.domainId ||
      customer.reset_epoch !== plan.resetEpoch ||
      customer.state !== 'active' ||
      customer.ledger_status !== 'ready' ||
      !registry?.ready ||
      registry.domain_id !== plan.domainId ||
      registry.reset_epoch !== plan.resetEpoch ||
      registry.role !== 'customer_deposit' ||
      registry.customer_id !== plan.customerId ||
      registry.account !== source.account ||
      registry.chain !== source.chain ||
      registry.network !== source.network ||
      registry.ledger_ack_revision !== source.registry_revision ||
      registry.listener_ack_revision <= 0 ||
      registry.registry_revision !== source.registry_revision ||
      registry.address !== source.address ||
      registry.hot_wallet_id !== hot.id ||
      !registry.start_cursor ||
      registry.ledger_status !== 'ready' ||
      registry.listener_status !== 'ready' ||
      hotRegistry?.ledger_status !== 'ready' ||
      hotRegistry.domain_id !== plan.domainId ||
      hotRegistry.reset_epoch !== plan.resetEpoch ||
      hotRegistry.role !== 'hot' ||
      hotRegistry.account !== 0 ||
      hotRegistry.customer_id !== null ||
      hotRegistry.chain !== source.chain ||
      hotRegistry.network !== source.network ||
      hotRegistry.ledger_ack_revision !== hot.registry_revision ||
      hotRegistry.registry_revision !== hot.registry_revision ||
      hotRegistry.address !== hot.address ||
      !asset?.sweep_enabled
    )
      throw new SweepDeferral(
        'paused_review',
        'Customer, registry coverage or native sweep capability is not enabled',
      );
    if (plan.data.asset.assetId !== `token:${source.chain}:native`)
      await this.tokenAuthority(tx, plan);
    const current = await tx.custodyExecution.findUnique({
      where: { operation_id: plan.operationId },
    });
    if (
      !plan.data.asset.assetId.endsWith(':native') &&
      current?.authorization &&
      (!current.ledger_intent_ack || !current.listener_intent_ack)
    )
      throw new SweepDeferral(
        'waiting_resources',
        'Token execution identity is not yet acknowledged',
      );
    return { source, hot };
  }

  private async fundingAuthority(
    tx: Prisma.TransactionClient,
    plan: Extract<Plan, { type: 'funding.plan.requested.v1' }>,
  ) {
    if (
      !this.config.tokensEnabled ||
      !this.config.authorityPrivateKey ||
      !this.config.signerPublicKey
    )
      throw new SweepDeferral('disabled', 'Management funding is disabled');
    await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${plan.domainId} FOR UPDATE`;
    await assertManagementFundingEnabled(tx, plan.domainId, plan.resetEpoch);
    await tx.$queryRaw`SELECT customer_id FROM exchange_customers WHERE customer_id=${plan.customerId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${plan.data.sourceWalletId}::uuid,${plan.data.destinationWalletId}::uuid) ORDER BY id FOR UPDATE`;
    const reservation = await tx.tokenFeeReservation.findUnique({
      where: { id: plan.data.feeReservationId },
    });
    const source = await tx.wallet.findUnique({ where: { id: plan.data.sourceWalletId } }),
      hot = await tx.wallet.findUnique({ where: { id: plan.data.destinationWalletId } });
    const customer = await tx.exchangeCustomer.findUnique({
      where: { customer_id: plan.customerId },
    });
    if (
      !reservation ||
      !source ||
      !hot ||
      reservation.id !== plan.operationId ||
      !['reserved', 'uncertain', 'reverted'].includes(reservation.state) ||
      reservation.kind !== 'gas_funding' ||
      reservation.domain_id !== plan.domainId ||
      reservation.reset_epoch !== plan.resetEpoch ||
      reservation.customer_id !== plan.customerId ||
      reservation.management_wallet_id !== source.id ||
      reservation.source_wallet_id !== hot.id ||
      reservation.principal_units !== plan.data.amount ||
      source.custody_role !== 'management' ||
      source.account !== 1 ||
      source.management_purpose !== 'gas_fee' ||
      hot.custody_role !== 'customer_deposit' ||
      hot.account < 10 ||
      hot.customer_id !== plan.customerId ||
      source.seed_id !== hot.seed_id ||
      source.chain !== 'ethereum' ||
      source.network !== '11155111' ||
      hot.chain !== source.chain ||
      hot.network !== source.network ||
      plan.data.asset.assetId !== 'token:ethereum:native' ||
      plan.data.asset.network !== source.network ||
      source.registry_revision !== plan.data.sourceRegistryRevision ||
      hot.registry_revision !== plan.data.hotRegistryRevision ||
      !source.address ||
      !hot.address ||
      !source.published_at ||
      !hot.published_at ||
      !(await this.custody.publicationAllowed(tx, source)) ||
      !(await this.custody.publicationAllowed(tx, hot)) ||
      customer?.state !== 'active' ||
      customer.ledger_status !== 'ready'
    )
      throw new SweepDeferral(
        'paused_review',
        'Funding reservation or custody authority is not ready',
      );
    const request =
      reservation.request as unknown as import('./token-fees.service.js').TokenFeeRequest;
    if (
      tokenAsset(request.certificate).assetId !== plan.data.fundedAssetId ||
      executionDigest(request.certificate) !== plan.data.certificateDigest
    )
      throw new ActionRejectedError('Funding certificate binding mismatch');
    const asset = await tx.assetConfiguration.findUnique({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: plan.domainId,
          chain: source.chain,
          network: source.network,
          asset_id: plan.data.fundedAssetId,
        },
      },
    });
    if (
      !asset?.sweep_enabled ||
      !asset.transfer_certificate ||
      executionDigest(asset.transfer_certificate) !== plan.data.certificateDigest
    )
      throw new SweepDeferral('paused_review', 'Funded token certification is paused');
    const registry = await tx.exchangeWalletRegistry.findMany({
      where: { wallet_id: { in: [source.id, hot.id] } },
    });
    if (
      registry.length !== 2 ||
      registry.some(
        (r) =>
          r.domain_id !== plan.domainId ||
          r.reset_epoch !== plan.resetEpoch ||
          r.ledger_status !== 'ready' ||
          r.ledger_ack_revision !== r.registry_revision ||
          r.registry_revision !==
            (r.wallet_id === source.id ? source.registry_revision : hot.registry_revision) ||
          (r.wallet_id === hot.id && (!r.ready || r.listener_ack_revision <= 0)),
      )
    )
      throw new SweepDeferral('paused_review', 'Funding registrations are not acknowledged');
    const current = await tx.custodyExecution.findUnique({
      where: { operation_id: plan.operationId },
    });
    if (current?.authorization && (!current.ledger_intent_ack || !current.listener_intent_ack))
      throw new SweepDeferral(
        'waiting_resources',
        'Funding identity must be acknowledged before broadcast',
      );
    return { source, hot };
  }

  private responseType(plan: Plan, result: 'prepared' | 'deferred'): ExchangeEvent['type'] {
    return `${plan.type === 'withdrawal.plan.requested.v1' ? 'withdrawal' : plan.type === 'funding.plan.requested.v1' ? 'funding' : 'sweep'}.plan.${result}.v1` as ExchangeEvent['type'];
  }

  private outputQueue(plan: Plan) {
    return plan.type === 'sweep.plan.requested.v1' ? QUEUES.sweep : QUEUES.wallet;
  }

  private async withdrawalAuthority(
    tx: Prisma.TransactionClient,
    plan: Extract<Plan, { type: 'withdrawal.plan.requested.v1' }>,
  ): Promise<{ source: Wallet; hot: Wallet }> {
    if (
      !(plan.data.asset.assetId.endsWith(':native')
        ? this.config.withdrawalsEnabled
        : this.config.tokensEnabled) ||
      !this.config.authorityPrivateKey ||
      !this.config.signerPublicKey
    )
      throw new SweepDeferral('disabled', 'Native withdrawals are disabled');
    // Block address publication changes while checking external destination ownership.
    await tx.$executeRaw`LOCK TABLE wallets IN SHARE MODE`;
    await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${plan.domainId} FOR UPDATE`;
    await tx.$queryRaw`SELECT customer_id FROM exchange_customers WHERE customer_id=${plan.customerId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM withdrawals WHERE id=${plan.operationId}::uuid FOR UPDATE`;
    const withdrawal = await tx.withdrawal.findUnique({ where: { id: plan.operationId } });
    if (
      !withdrawal ||
      withdrawal.cancel_requested ||
      withdrawal.customer_id !== plan.customerId ||
      withdrawal.domain_id !== plan.domainId ||
      withdrawal.reset_epoch !== plan.resetEpoch ||
      withdrawal.request_digest !== plan.requestDigest ||
      withdrawal.reservation_id !== plan.data.reservationId ||
      withdrawal.attempt_id !== plan.attemptId ||
      withdrawal.destination !== plan.data.destination ||
      withdrawal.principal_units !== plan.data.amount ||
      withdrawal.hot_wallet_id !== plan.data.sourceWalletId ||
      plan.data.destinationWalletId !== plan.data.sourceWalletId ||
      withdrawal.hot_registry_revision !== plan.data.hotRegistryRevision ||
      plan.data.hotRegistryRevision !== plan.data.sourceRegistryRevision
    )
      throw new SweepDeferral(
        'paused_review',
        'Withdrawal intent, hold or hot identity is not ready',
      );
    await tx.$queryRaw`SELECT id FROM wallets WHERE id=${withdrawal.hot_wallet_id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT wallet_id FROM exchange_wallet_registry WHERE wallet_id=${withdrawal.hot_wallet_id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT domain_id FROM asset_configurations WHERE domain_id=${plan.domainId} AND chain=${plan.data.asset.chain} AND network=${plan.data.asset.network} AND asset_id=${plan.data.asset.assetId} FOR UPDATE`;
    const hot = await tx.wallet.findUnique({ where: { id: withdrawal.hot_wallet_id } });
    const customer = await tx.exchangeCustomer.findUnique({
      where: { customer_id: plan.customerId },
    });
    const registry = await tx.exchangeWalletRegistry.findUnique({
      where: { wallet_id: withdrawal.hot_wallet_id },
    });
    const asset = await tx.assetConfiguration.findUnique({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: plan.domainId,
          ...{
            chain: plan.data.asset.chain,
            network: plan.data.asset.network,
            asset_id: plan.data.asset.assetId,
          },
        },
      },
    });
    if (
      !hot ||
      hot.custody_role !== 'hot' ||
      hot.account !== 0 ||
      hot.customer_id !== null ||
      !hot.address ||
      !hot.published_at ||
      hot.registry_revision !== withdrawal.hot_registry_revision ||
      hot.chain !== plan.data.asset.chain ||
      hot.network !== plan.data.asset.network ||
      !(await this.custody.publicationAllowed(tx, hot)) ||
      customer?.state !== 'active' ||
      customer.ledger_status !== 'ready' ||
      customer.domain_id !== plan.domainId ||
      customer.reset_epoch !== plan.resetEpoch ||
      registry?.role !== 'hot' ||
      registry.address !== hot.address ||
      registry.reset_epoch !== plan.resetEpoch ||
      registry.domain_id !== plan.domainId ||
      registry.registry_revision !== hot.registry_revision ||
      registry.ledger_ack_revision !== hot.registry_revision ||
      registry.ledger_status !== 'ready' ||
      !asset?.withdrawal_enabled ||
      asset.policy_version !== plan.policyVersion
    )
      throw new SweepDeferral(
        'paused_review',
        'Customer, hot custody or withdrawal capability is not ready',
      );
    if (!plan.data.asset.assetId.endsWith(':native')) await this.tokenAuthority(tx, plan);
    const owned = await tx.wallet.findFirst({
      where: {
        chain: hot.chain,
        network: hot.network,
        address:
          hot.chain === 'solana'
            ? withdrawal.destination
            : { equals: withdrawal.destination, mode: 'insensitive' },
      },
    });
    if (
      owned ||
      (await tx.exchangeWalletRegistry.findFirst({
        where: {
          chain: hot.chain,
          network: hot.network,
          address:
            hot.chain === 'solana'
              ? withdrawal.destination
              : { equals: withdrawal.destination, mode: 'insensitive' },
        },
      }))
    )
      throw new SweepDeferral(
        'paused_review',
        'Exchange-owned destinations require an internal transfer',
      );
    const current = await tx.custodyExecution.findUnique({
      where: { operation_id: plan.operationId },
    });
    if (
      !plan.data.asset.assetId.endsWith(':native') &&
      current?.authorization &&
      (!current.ledger_intent_ack || !current.listener_intent_ack)
    )
      throw new SweepDeferral(
        'waiting_resources',
        'Token withdrawal identity is not yet acknowledged',
      );
    return { source: hot, hot };
  }

  private output(
    execution: CustodyExecution,
    type: string,
    data: unknown,
    revision = 1,
  ): ExchangeEvent {
    const plan = execution.plan as unknown as Plan;
    return exchangeEventSchema.parse({
      ...plan,
      type,
      data,
      eventId: eventId([execution.id, type, revision]),
      revision,
      occurredAt: execution.created_at.toISOString(),
      causationId: plan.eventId,
    });
  }

  private async deferred(plan: Plan, code: string, reason: string, tx: Prisma.TransactionClient) {
    const response = exchangeEventSchema.parse({
      ...plan,
      type: this.responseType(plan, 'deferred'),
      eventId:
        plan.type === 'withdrawal.plan.requested.v1'
          ? randomUUID()
          : eventId([plan.attemptId, 'deferred']),
      causationId: plan.eventId,
      revision: 1,
      data: {
        code,
        reason: reason.slice(0, 500),
        retryAfter: new Date(
          Date.parse(plan.occurredAt) + this.config.pollIntervalMs,
        ).toISOString(),
      },
    });
    await enqueueFanOut(tx, response, [this.outputQueue(plan)]);
  }

  private async plan(plan: Plan) {
    this.validatePlan(plan);
    let execution: CustodyExecution | null;
    try {
      execution = await this.db.$transaction(async (tx) => {
        await lock(tx, `custody-source:${plan.data.sourceWalletId}`);
        const retired = await tx.outbox.findUnique({
          where: {
            dedupe_key: `exchange-${eventId([plan.attemptId, 'deferred'])}-${this.outputQueue(plan)}`,
          },
        });
        if (retired && plan.type !== 'withdrawal.plan.requested.v1') {
          const response = exchangeEventSchema.parse(retired.payload);
          if (
            response.operationId !== plan.operationId ||
            response.requestDigest !== plan.requestDigest ||
            response.customerId !== plan.customerId
          )
            throw new ActionRejectedError('Retired planning attempt identity changed');
          return null;
        }
        const previous = await tx.custodyExecution.findUnique({
          where: { operation_id: plan.operationId },
        });
        if (previous) {
          if (
            previous.attempt_id !== plan.attemptId ||
            previous.request_digest !== plan.requestDigest ||
            canonical((previous.plan as unknown as Plan).data) !== canonical(plan.data)
          )
            throw new ActionRejectedError('Sweep operation identity changed');
          return previous;
        }
        const { source } = await this.authority(tx, plan);
        if (
          await tx.withdrawalBatchDraft.findFirst({
            where: { source_wallet_id: source.id, state: 'planned' },
          })
        )
          throw new SweepDeferral(
            'waiting_resources',
            'Source belongs to a retained unsigned batch draft',
          );
        if (
          (await tx.custodyExecution.findFirst({
            where: { source_wallet_id: source.id, retired_at: null },
          })) ||
          (await tx.transaction.findFirst({
            where: {
              wallet_id: source.id,
              status: {
                in: [
                  'preparing',
                  'signing',
                  'signed',
                  'queued',
                  'broadcasting',
                  'submitted',
                  'attention',
                ],
              },
            },
          }))
        )
          throw new SweepDeferral(
            'waiting_resources',
            'Source execution slot is retained by another attempt',
          );
        await tx.transaction.create({
          data: {
            id: plan.attemptId,
            wallet_id: source.id,
            idempotency_key: `custody:${plan.attemptId}`,
            request_hash: plan.requestDigest,
            intent: json(plan.data),
            status: 'preparing',
          },
        });
        return tx.custodyExecution.create({
          data: {
            id: plan.attemptId,
            operation_id: plan.operationId,
            attempt_id: plan.attemptId,
            transaction_id: plan.attemptId,
            domain_id: plan.domainId,
            reset_epoch: plan.resetEpoch,
            customer_id: plan.customerId,
            source_wallet_id: source.id,
            hot_wallet_id: plan.data.destinationWalletId,
            request_digest: plan.requestDigest,
            plan: json(plan),
            state: 'planning',
          },
        });
      });
    } catch (error) {
      if (error instanceof SweepDeferral) {
        execution = await this.db.$transaction(async (tx) => {
          await lock(tx, `custody-source:${plan.data.sourceWalletId}`);
          const accepted = await tx.custodyExecution.findUnique({
            where: { operation_id: plan.operationId },
          });
          if (accepted) {
            if (
              accepted.attempt_id !== plan.attemptId ||
              accepted.request_digest !== plan.requestDigest
            )
              throw new ActionRejectedError('Sweep operation identity changed');
            return accepted;
          }
          const existing = await tx.outbox.findUnique({
            where: {
              dedupe_key: `exchange-${eventId([plan.attemptId, 'deferred'])}-${this.outputQueue(plan)}`,
            },
          });
          if (!existing || plan.type === 'withdrawal.plan.requested.v1')
            await this.deferred(plan, error.code, error.message, tx);
          return null;
        });
      } else {
        throw error;
      }
    }
    if (execution?.state === 'planning') await this.prepare(execution);
  }

  private async nativeDrainGuard(source: Wallet) {
    if (
      await this.db.tokenFeeReservation.findFirst({
        where: {
          source_wallet_id: source.id,
          state: { in: ['reserved', 'uncertain', 'reverted'] },
        },
      })
    )
      throw new SweepDeferral('waiting_funds', 'Native fee dependency is still reserved');
    const assets = await this.db.assetConfiguration.findMany({
      where: {
        domain_id: source.custody_domain_id!,
        chain: source.chain,
        network: source.network,
        sweep_enabled: true,
        standard: { in: ['erc20', 'spl'] },
      },
    });
    for (const asset of assets) {
      const c = tokenCertificateSchema.parse(asset.transfer_certificate),
        planner = new TokenPlanner(this.rpc);
      await planner.validateCertificate(c);
      if (c.standard === 'erc20') {
        for (const tag of ['finalized', 'pending']) {
          const value = await this.rpc.call('ethereum', 'eth_call', [
            {
              to: c.contract,
              data: '0x70a08231' + source.address!.slice(2).toLowerCase().padStart(64, '0'),
            },
            tag,
          ]);
          if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
            throw new SweepDeferral('unavailable', 'Token inventory is unavailable');
          if (BigInt(value) > 0n)
            throw new SweepDeferral(
              'waiting_funds',
              'Preserve native gas until certified token inventory is swept',
            );
        }
      } else if (
        (await planner.discoverOwnedAccounts(c, source.address!)).some((a) => BigInt(a.amount) > 0n)
      )
        throw new SweepDeferral(
          'waiting_funds',
          'Preserve native funds until owned token accounts are swept or reviewed',
        );
    }
  }

  private async prepare(execution: CustodyExecution) {
    const plan = execution.plan as unknown as Plan;
    try {
      const wallets = await this.db.$transaction((tx) => this.authority(tx, plan));
      if (plan.type === 'sweep.plan.requested.v1' && plan.data.asset.assetId.endsWith(':native'))
        await this.nativeDrainGuard(wallets.source);
      if (!plan.data.asset.assetId.endsWith(':native')) {
        await this.prepareToken(execution, plan, wallets);
        return;
      }
      const prepared = await this.planner.plan({
        chain: plan.data.asset.chain,
        network: plan.data.asset.network,
        sourceAddress: wallets.source.address!,
        hotAddress:
          plan.type === 'withdrawal.plan.requested.v1'
            ? plan.data.destination
            : wallets.hot.address!,
        ...(plan.type !== 'sweep.plan.requested.v1' ? { amount: plan.data.amount } : {}),
      });
      if (plan.type === 'funding.plan.requested.v1') {
        const budget = await this.db.tokenFeeReservation.findUniqueOrThrow({
          where: { id: plan.operationId },
        });
        if (BigInt(prepared.maxFeeUnits) > BigInt(budget.maximum_fee_units))
          throw new SweepDeferral('fee_budget', 'Funding fee quote exceeds reserved budget');
      }
      const request = signSchema.parse({
        wallet: {
          chain: plan.data.asset.chain,
          network: plan.data.asset.network,
          seedId: wallets.source.seed_id,
          account: wallets.source.account,
          address: wallets.source.address,
        },
        transaction: prepared.request,
      });
      await this.db.$transaction(async (tx) => {
        await lock(tx, `custody-source:${execution.source_wallet_id}`);
        const current = await tx.custodyExecution.findUniqueOrThrow({
          where: { id: execution.id },
        });
        if (current.state !== 'planning') return;
        await this.authority(tx, plan);
        if (request.transaction.chain === 'ethereum')
          await (this.liquidity ?? new EvmLiquidityService(this.rpc)).reserve(
            tx,
            current,
            wallets.source,
            request.transaction.nonce,
            prepared.maxFeeUnits,
          );
        const keys = prepared.resourceKeys
          .map(
            (key) =>
              `${plan.domainId}:${plan.resetEpoch}:${plan.data.asset.chain}:${plan.data.asset.network}:${key}`,
          )
          .sort();
        for (const key of keys) {
          await lock(tx, `execution-resource:${key}`);
          if (
            await tx.executionResourceClaim.findFirst({
              where: { resource_key: key, active: true },
            })
          )
            throw new SweepDeferral(
              'waiting_resources',
              'Canonical resource is reserved by another attempt',
            );
        }
        for (const key of keys)
          await tx.executionResourceClaim.create({
            data: { id: randomUUID(), resource_key: key, execution_id: current.id },
          });
        const updated = await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            state: 'prepared',
            prepared_request: json(request),
            preparation_digest: executionRequestDigest(request),
            principal_units: prepared.amount,
            maximum_fee_units: prepared.maxFeeUnits,
            expires_at: new Date(prepared.expiresAt),
            next_check_at: new Date(prepared.expiresAt),
          },
        });
        await tx.transaction.update({
          where: { id: current.transaction_id },
          data: { prepared: json(request.transaction) },
        });
        await enqueueFanOut(
          tx,
          this.output(updated, this.responseType(plan, 'prepared'), {
            sourceWalletId: current.source_wallet_id,
            destinationWalletId: current.hot_wallet_id,
            amount: { asset: plan.data.asset, amount: prepared.amount },
            preparationDigest: updated.preparation_digest,
            maxFeeUnits: prepared.maxFeeUnits,
            expiresAt: prepared.expiresAt,
          }),
          [this.outputQueue(plan)],
        );
      });
    } catch (error) {
      if (error instanceof ActionRejectedError) throw error;
      if (plan.type === 'withdrawal.plan.requested.v1') {
        await this.db.$transaction(async (tx) => {
          await lock(tx, `custody-source:${execution.source_wallet_id}`);
          const current = await tx.custodyExecution.findUniqueOrThrow({
            where: { id: execution.id },
          });
          if (current.state !== 'planning' || current.authorization || current.retired_at) return;
          const updated = await tx.custodyExecution.update({
            where: { id: current.id },
            data: {
              last_error:
                error instanceof SweepDeferral
                  ? error.message
                  : 'Canonical preparation unavailable; hold retained',
              next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
              revision: { increment: 1 },
            },
          });
          await this.emitAttempt(tx, updated, false);
        });
        return;
      }
      await this.unsignedFailure(
        execution,
        error instanceof SweepDeferral ? error.code : 'preparation_failed',
        error instanceof SweepDeferral
          ? error.message
          : 'Canonical resource preparation failed; retry from a fresh plan',
      );
    }
  }

  private async tokenCosts(
    tx: Prisma.TransactionClient,
    plan: Plan,
    prepared: TokenPreparation,
    source: Wallet,
    hot: Wallet,
  ) {
    const { sponsor } = await this.tokenAuthority(tx, plan);
    const payer = sponsor ?? source;
    return {
      certificate: prepared.certificate,
      feePayerWalletId: payer.id,
      feePayerRegistryRevision: payer.registry_revision,
      maximumFeeUnits: prepared.maxFeeUnits,
      maximumRentUnits: prepared.rentUnits,
      ...(prepared.certificate.standard === 'spl' && plan.type === 'sweep.plan.requested.v1'
        ? { rentCustodyWalletId: hot.id }
        : {}),
    };
  }

  private async requestFunding(plan: Plan, customerWallet: Wallet, prepared: TokenPreparation) {
    const management = await this.db.wallet.findFirstOrThrow({
      where: {
        custody_domain_id: plan.domainId,
        reset_epoch: plan.resetEpoch,
        chain: 'ethereum',
        network: '11155111',
        custody_role: 'management',
        account: 1,
        active: true,
      },
    });
    const quote = await this.planner.plan({
      chain: 'ethereum',
      network: '11155111',
      sourceAddress: management.address!,
      hotAddress: customerWallet.address!,
      amount: prepared.fundingShortfallUnits,
    });
    await this.db.$transaction(async (tx) => {
      const budget = await new TokenFeesService(this.db, this.rpc).reserve(
        {
          domainId: plan.domainId,
          resetEpoch: plan.resetEpoch,
          customerId: plan.customerId,
          sourceWalletId: customerWallet.id,
          managementWalletId: management.id,
          sourceRegistryRevision: customerWallet.registry_revision,
          managementRegistryRevision: management.registry_revision,
          operationId: plan.operationId,
          attemptId: plan.attemptId,
          generation: plan.data.generation,
          certificate: prepared.certificate,
          kind: 'gas_funding',
          principalUnits: prepared.fundingShortfallUnits,
          maximumFeeUnits: quote.maxFeeUnits,
          maximumRentUnits: '0',
        },
        tx,
      );
      if (budget.state !== 'reserved') return;
      const request =
        budget.request as unknown as import('./token-fees.service.js').TokenFeeRequest;
      const operationId = budget.id,
        attemptId = eventId([budget.id, 'funding-attempt']);
      const data = {
        sourceWalletId: budget.management_wallet_id,
        destinationWalletId: budget.source_wallet_id,
        asset: { chain: 'ethereum', network: '11155111', assetId: 'token:ethereum:native' },
        sourceRegistryRevision: request.managementRegistryRevision,
        hotRegistryRevision: request.sourceRegistryRevision,
        generation: request.generation,
        amount: budget.principal_units,
        feeReservationId: budget.id,
        fundedAssetId: tokenAsset(request.certificate).assetId,
        certificateDigest: executionDigest(request.certificate),
      };
      const requestDigest = executionDigest({
        domainId: plan.domainId,
        resetEpoch: plan.resetEpoch,
        customerId: plan.customerId,
        operationId,
        attemptId,
        policyVersion: plan.policyVersion,
        data,
      });
      const event = exchangeEventSchema.parse({
        ...plan,
        type: 'funding.plan.requested.v1',
        eventId: eventId([budget.id, 'funding-plan']),
        causationId: plan.eventId,
        aggregateId: operationId,
        operationId,
        attemptId,
        requestDigest,
        data,
      });
      await enqueue(tx, QUEUES.wallet, event, `funding-plan:${budget.id}`);
    });
  }

  private async prepareToken(
    execution: CustodyExecution,
    plan: Plan,
    wallets: { source: Wallet; hot: Wallet },
  ) {
    const { certificate, sponsor } = await this.db.$transaction((tx) =>
      this.tokenAuthority(tx, plan),
    );
    if (
      certificate.standard === 'erc20' &&
      (await this.db.tokenFeeReservation.findFirst({
        where: {
          source_wallet_id: wallets.source.id,
          kind: 'gas_funding',
          state: { in: ['reserved', 'uncertain', 'reverted'] },
        },
      }))
    )
      throw new SweepDeferral(
        'waiting_funds',
        'Prior funding dependency is not canonically settled and acknowledged',
      );
    const prepared = await new TokenPlanner(this.rpc).plan({
      certificate,
      wallet: {
        chain: certificate.chain,
        network: certificate.network,
        seedId: wallets.source.seed_id,
        account: wallets.source.account,
        address: wallets.source.address!,
      },
      recipientOwner:
        plan.type === 'withdrawal.plan.requested.v1' ? plan.data.destination : wallets.hot.address!,
      ...(plan.type === 'withdrawal.plan.requested.v1' ? { amount: plan.data.amount } : {}),
      ...(certificate.standard === 'spl'
        ? {
            feePayer: {
              chain: 'solana' as const,
              network: certificate.network,
              seedId: wallets.source.seed_id,
              account: sponsor ? 1 : 0,
              address: sponsor?.address ?? wallets.source.address!,
            },
          }
        : {}),
    });
    if (prepared.fundingShortfallUnits !== '0') {
      if (certificate.standard === 'erc20' && plan.type === 'sweep.plan.requested.v1')
        await this.requestFunding(plan, wallets.source, prepared);
      throw new SweepDeferral(
        'waiting_funds',
        'Token execution requires confirmed native fee funding',
      );
    }
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      if (current.state !== 'planning') return;
      await this.authority(tx, plan);
      if (prepared.request.transaction.kind === 'erc20')
        await (this.liquidity ?? new EvmLiquidityService(this.rpc)).reserve(
          tx,
          current,
          wallets.source,
          prepared.request.transaction.nonce,
          prepared.maxFeeUnits,
        );
      if (sponsor)
        await new TokenFeesService(this.db, this.rpc).reserve(
          {
            domainId: plan.domainId,
            resetEpoch: plan.resetEpoch,
            customerId: plan.customerId,
            sourceWalletId: wallets.source.id,
            managementWalletId: sponsor.id,
            sourceRegistryRevision: wallets.source.registry_revision,
            managementRegistryRevision: sponsor.registry_revision,
            operationId: plan.operationId,
            attemptId: plan.attemptId,
            generation: plan.data.generation,
            certificate,
            kind: 'spl_sponsorship',
            principalUnits: '0',
            maximumFeeUnits: prepared.maxFeeUnits,
            maximumRentUnits: prepared.rentUnits,
          },
          tx,
        );
      const keys = prepared.resourceKeys
        .map(
          (key) =>
            `${plan.domainId}:${plan.resetEpoch}:${certificate.chain}:${certificate.network}:${key}`,
        )
        .sort();
      for (const key of keys) {
        await lock(tx, `execution-resource:${key}`);
        if (
          await tx.executionResourceClaim.findFirst({ where: { resource_key: key, active: true } })
        )
          throw new SweepDeferral('waiting_resources', 'Token/source/sponsor resource is reserved');
      }
      for (const key of keys)
        await tx.executionResourceClaim.create({
          data: { id: randomUUID(), resource_key: key, execution_id: current.id },
        });
      const updated = await tx.custodyExecution.update({
        where: { id: current.id },
        data: {
          state: 'prepared',
          prepared_request: json(prepared),
          preparation_digest: prepared.preparedDigest,
          principal_units: prepared.request.transaction.amount,
          maximum_fee_units: prepared.maxFeeUnits,
          expires_at: new Date(prepared.expiresAt),
          next_check_at: new Date(prepared.expiresAt),
        },
      });
      await tx.transaction.update({
        where: { id: current.transaction_id },
        data: { prepared: json(prepared.request.transaction) },
      });
      await enqueueFanOut(
        tx,
        this.output(
          updated,
          plan.type === 'withdrawal.plan.requested.v1'
            ? 'withdrawal.plan.prepared.v1'
            : 'sweep.plan.prepared.v1',
          {
            sourceWalletId: current.source_wallet_id,
            destinationWalletId: current.hot_wallet_id,
            amount: { asset: plan.data.asset, amount: prepared.request.transaction.amount },
            preparationDigest: prepared.preparedDigest,
            maxFeeUnits: prepared.maxFeeUnits,
            expiresAt: prepared.expiresAt,
            tokenCosts: await this.tokenCosts(tx, plan, prepared, wallets.source, wallets.hot),
          },
        ),
        [plan.type === 'withdrawal.plan.requested.v1' ? QUEUES.wallet : QUEUES.sweep],
      );
    });
  }

  private async unsignedFailure(execution: CustodyExecution, code: string, reason: string) {
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      if (!['planning', 'prepared'].includes(current.state) || current.authorization) return;
      await tx.custodyExecution.update({
        where: { id: current.id },
        data: {
          state: 'deferred',
          retired_at: new Date(),
          last_error: reason,
          next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
        },
      });
      await tx.transaction.update({
        where: { id: current.transaction_id },
        data: { status: 'rejected', last_error: reason },
      });
      await tx.executionResourceClaim.updateMany({
        where: { execution_id: current.id, active: true },
        data: { active: false, released_at: new Date() },
      });
      await tx.tokenFeeReservation.updateMany({
        where: {
          state: 'reserved',
          OR: [
            { kind: 'gas_funding', id: current.operation_id },
            {
              kind: 'spl_sponsorship',
              request: { path: ['operationId'], equals: current.operation_id },
            },
          ],
        },
        data: { state: 'released' },
      });
      const plan = current.plan as unknown as Plan;
      const response = exchangeEventSchema.parse({
        ...plan,
        type: this.responseType(plan, 'deferred'),
        eventId:
          plan.type === 'withdrawal.plan.requested.v1'
            ? randomUUID()
            : eventId([plan.attemptId, 'deferred']),
        causationId: plan.eventId,
        revision: 1,
        data: {
          terminalSafe: true,
          ...(current.preparation_digest ? { preparationDigest: current.preparation_digest } : {}),
          code,
          reason: reason.slice(0, 500),
          retryAfter: new Date(
            Date.parse(plan.occurredAt) + this.config.pollIntervalMs,
          ).toISOString(),
        },
      });
      await enqueueFanOut(tx, response, [this.outputQueue(plan)]);
    });
  }

  private async execute(event: Execute) {
    const execution = await this.db.custodyExecution.findUnique({
      where: { operation_id: event.operationId },
    });
    if (!execution) throw new Error('Prepared sweep has not arrived');
    this.checkIdentity(execution, event);
    const plan = execution.plan as unknown as Plan;
    if (
      event.data.sourceWalletId !== execution.source_wallet_id ||
      (event.type !== 'withdrawal.execute.requested.v1'
        ? event.data.destinationWalletId !== execution.hot_wallet_id
        : plan.type !== 'withdrawal.plan.requested.v1' ||
          event.data.destination !== plan.data.destination) ||
      event.data.amount.amount !== execution.principal_units ||
      canonical(event.data.amount.asset) !== canonical(plan.data.asset) ||
      event.data.preparationDigest !== execution.preparation_digest ||
      event.policyVersion !== plan.policyVersion
    )
      throw new ActionRejectedError('Sweep execution differs from reserved preparation');
    if (execution.state !== 'prepared') return;
    const request = this.request(execution);
    try {
      if (!execution.expires_at || execution.expires_at.getTime() <= Date.now())
        throw new SweepDeferral('preparation_expired', 'Unsigned preparation expired');
      const token = this.tokenPreparation(execution);
      if (plan.type === 'sweep.plan.requested.v1' && !token)
        await this.nativeDrainGuard(
          await this.db.wallet.findUniqueOrThrow({ where: { id: execution.source_wallet_id } }),
        );
      if (token) await new TokenPlanner(this.rpc).revalidate(token);
      else await this.planner.revalidate(signSchema.parse(request), execution.maximum_fee_units!);
      await this.db.$transaction(async (tx) => {
        await lock(tx, `custody-source:${execution.source_wallet_id}`);
        const current = await tx.custodyExecution.findUniqueOrThrow({
          where: { id: execution.id },
        });
        if (current.state !== 'prepared') return;
        const { source, hot } = await this.authority(tx, plan);
        if (request.wallet.chain === 'ethereum' && 'nonce' in request.transaction)
          await (this.liquidity ?? new EvmLiquidityService(this.rpc)).reserve(
            tx,
            current,
            source,
            request.transaction.nonce,
            current.maximum_fee_units!,
          );
        if (current.expires_at!.getTime() <= Date.now())
          throw new SweepDeferral('preparation_expired', 'Unsigned preparation expired');
        const token = this.tokenPreparation(current);
        const tokenAuthority = token ? await this.tokenAuthority(tx, plan) : undefined;
        const authorization = token
          ? signTokenExecutionAuthorization(
              {
                version: 1,
                domainId: plan.domainId,
                resetEpoch: plan.resetEpoch,
                seedId: source.seed_id,
                customerId: plan.customerId,
                operationId: current.operation_id,
                attemptId: current.attempt_id,
                requestDigest: current.request_digest,
                preparationDigest: token.preparedDigest,
                requestHash: executionDigest(token.request),
                certificate: token.certificate,
                policyVersion: 'exchange-token-v1',
                recipientPolicy: 'external-wallet-v1',
                expiresAt: token.expiresAt,
                ...(plan.type === 'withdrawal.plan.requested.v1'
                  ? {
                      purpose: 'token_withdrawal' as const,
                      reservationId: plan.data.reservationId,
                      source: {
                        walletId: source.id,
                        role: 'hot' as const,
                        account: 0 as const,
                        path: source.path,
                        address: source.address!,
                        registryRevision: source.registry_revision,
                      },
                      target: { role: 'external' as const, address: plan.data.destination },
                    }
                  : {
                      purpose: 'token_sweep' as const,
                      source: {
                        walletId: source.id,
                        role: 'customer_deposit' as const,
                        account: source.account,
                        path: source.path,
                        address: source.address!,
                        registryRevision: source.registry_revision,
                      },
                      target: {
                        walletId: hot.id,
                        role: 'hot' as const,
                        account: 0 as const,
                        path: hot.path,
                        address: hot.address!,
                        registryRevision: hot.registry_revision,
                        seedId: hot.seed_id,
                        domainId: plan.domainId,
                      },
                    }),
                ...(tokenAuthority?.sponsor
                  ? {
                      sponsor: {
                        walletId: tokenAuthority.sponsor.id,
                        role: 'management' as const,
                        account: 1 as const,
                        path: tokenAuthority.sponsor.path,
                        address: tokenAuthority.sponsor.address!,
                        registryRevision: tokenAuthority.sponsor.registry_revision,
                      },
                    }
                  : {}),
              },
              this.config.authorityPrivateKey!,
            )
          : signExecutionAuthorization(
              {
                version: 1,
                ...(plan.type === 'funding.plan.requested.v1'
                  ? {
                      purpose: 'native_funding' as const,
                      fundingReservationId: plan.data.feeReservationId,
                      fundedAssetId: plan.data.fundedAssetId,
                      certificateDigest: plan.data.certificateDigest,
                      source: {
                        walletId: source.id,
                        role: 'management' as const,
                        account: 1 as const,
                        path: source.path,
                        address: source.address!,
                        registryRevision: source.registry_revision,
                      },
                      target: {
                        walletId: hot.id,
                        role: 'customer_deposit' as const,
                        account: hot.account,
                        path: hot.path,
                        address: hot.address!,
                        registryRevision: hot.registry_revision,
                        seedId: hot.seed_id,
                        domainId: plan.domainId,
                      },
                    }
                  : plan.type === 'withdrawal.plan.requested.v1'
                    ? {
                        purpose: 'native_withdrawal' as const,
                        reservationId: plan.data.reservationId,
                        source: {
                          walletId: source.id,
                          role: 'hot' as const,
                          account: 0 as const,
                          path: source.path,
                          address: source.address!,
                          registryRevision: source.registry_revision,
                        },
                        target: { role: 'external' as const, address: plan.data.destination },
                      }
                    : {
                        purpose: 'native_sweep' as const,
                        source: {
                          walletId: source.id,
                          role: 'customer_deposit' as const,
                          account: source.account,
                          path: source.path,
                          address: source.address!,
                          registryRevision: source.registry_revision,
                        },
                        target: {
                          walletId: hot.id,
                          role: 'hot' as const,
                          account: 0 as const,
                          path: hot.path,
                          address: hot.address!,
                          seedId: hot.seed_id,
                          domainId: plan.domainId,
                          registryRevision: hot.registry_revision,
                        },
                      }),
                domainId: plan.domainId,
                resetEpoch: plan.resetEpoch,
                seedId: source.seed_id,
                customerId: plan.customerId,
                asset: nativeExecutionAssetSchema.parse(plan.data.asset),
                policyVersion: 'exchange-financial-v1',
                operationId: current.operation_id,
                attemptId: current.attempt_id,
                requestDigest: current.request_digest,
                preparationDigest: current.preparation_digest!,
                principalUnits: current.principal_units!,
                maxFeeUnits: current.maximum_fee_units!,
                expiresAt: current.expires_at!.toISOString(),
                requestHash: executionRequestDigest(signSchema.parse(request)),
              },
              this.config.authorityPrivateKey!,
            );
        const updated = await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            state: 'signing',
            authorization: json(authorization),
            revision: { increment: 1 },
            next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
          },
        });
        await tx.transaction.update({
          where: { id: current.transaction_id },
          data: { status: 'signing' },
        });
        if (token || plan.type === 'funding.plan.requested.v1')
          await tx.tokenFeeReservation.updateMany({
            where: {
              state: 'reserved',
              OR: [
                { id: current.operation_id },
                { request: { path: ['operationId'], equals: current.operation_id } },
              ],
            },
            data: { state: 'uncertain' },
          });
        if (
          token ||
          event.type === 'withdrawal.execute.requested.v1' ||
          event.type === 'funding.execute.requested.v1'
        ) {
          const costs = token ? await this.tokenCosts(tx, plan, token, source, hot) : undefined;
          if (
            token &&
            canonical('tokenCosts' in event.data ? event.data.tokenCosts : undefined) !==
              canonical(costs)
          )
            throw new ActionRejectedError('Token execution fee/rent binding mismatch');
          await enqueueFanOut(tx, event, [QUEUES.ledger, QUEUES.activity]);
        }
        if (event.type === 'withdrawal.execute.requested.v1') {
          await tx.withdrawal.update({
            where: { id: current.operation_id },
            data: { state: 'executing', revision: { increment: 1 } },
          });
        }
        await enqueue(
          tx,
          QUEUES.signer,
          messageSchema.parse({
            ...(token
              ? { type: 'transaction.token.sign' as const, prepared: token }
              : { type: 'transaction.custody.sign' as const, request: signSchema.parse(request) }),
            transactionId: current.transaction_id,
            operationId: current.operation_id,
            attemptId: current.attempt_id,
            requestDigest: current.request_digest,
            preparationDigest: current.preparation_digest!,
            authorization,
          }),
          `custody-sign:${current.attempt_id}`,
        );
        await this.emitAttempt(tx, updated, false);
      });
    } catch (error) {
      if (error instanceof SweepDeferral) {
        await this.unsignedFailure(execution, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  private checkIdentity(
    execution: CustodyExecution,
    event: {
      domainId: string;
      resetEpoch: string;
      attemptId: string;
      requestDigest: string;
      customerId?: string;
    },
  ) {
    if (
      execution.domain_id !== event.domainId ||
      execution.reset_epoch !== event.resetEpoch ||
      event.resetEpoch !== this.auth.resetEpoch ||
      execution.attempt_id !== event.attemptId ||
      execution.request_digest !== event.requestDigest ||
      (event.customerId && execution.customer_id !== event.customerId)
    )
      throw new ActionRejectedError('Execution result identity mismatch');
  }

  private async emitAttempt(
    tx: Prisma.TransactionClient,
    execution: CustodyExecution,
    terminalSafe: boolean,
  ) {
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: execution.transaction_id },
    });
    await enqueueFanOut(
      tx,
      this.output(
        execution,
        'execution.attempt.updated.v1',
        {
          state: execution.state === 'planning' ? 'preparing' : execution.state,
          ...(transaction.tx_hash ? { transactionHash: transaction.tx_hash } : {}),
          ...(execution.last_error ? { reason: execution.last_error } : {}),
          terminalSafe,
          ...(terminalSafe ? { settlementRevision: execution.settlement_revision } : {}),
        },
        execution.revision,
      ),
      [QUEUES.ledger, QUEUES.activity, this.outputQueue(execution.plan as unknown as Plan)],
    );
  }

  private async signed(result: Result) {
    if (!this.config.signerPublicKey)
      throw new ActionRejectedError('Signer attestation verifier is unavailable');
    const { signerAttestation, ...body } = result;
    let claims;
    try {
      claims = verifySignerAttestation(signerAttestation, body, this.config.signerPublicKey);
    } catch {
      throw new ActionRejectedError('Invalid independent Signer result attestation');
    }
    const execution = await this.db.custodyExecution.findUnique({
      where: { transaction_id: result.transactionId },
    });
    if (!execution) throw new ActionRejectedError('Execution attempt not found');
    this.checkIdentity(execution, claims);
    if (
      claims.transactionId !== execution.transaction_id ||
      result.operationId !== execution.operation_id ||
      result.attemptId !== execution.attempt_id ||
      result.requestDigest !== execution.request_digest ||
      result.preparationDigest !== execution.preparation_digest ||
      claims.preparationDigest !== execution.preparation_digest ||
      claims.status !== (result.type === 'transaction.custody.signed' ? 'signed' : 'rejected')
    )
      throw new ActionRejectedError('Signer result preparation binding mismatch');
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: execution.transaction_id },
      });
      if (
        current.state !== 'signing' &&
        !(current.state === 'attention' && current.authorization && !transaction.signed)
      ) {
        if (
          result.type === 'transaction.custody.signed' &&
          transaction.signed &&
          canonical(transaction.signed) !== canonical(result.signed)
        )
          throw new ActionRejectedError('Signed custody bytes are immutable');
        return;
      }
      if (result.type === 'transaction.custody.rejected') {
        const updated = await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            state: 'attention',
            revision: { increment: 1 },
            next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
            last_error:
              'Signer rejection after authorization; earlier signing remains uncertain and resources retained',
          },
        });
        await tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'attention', last_error: updated.last_error },
        });
        await this.emitAttempt(tx, updated, false);
        return;
      }
      const request = this.request(current);
      let ready = true;
      try {
        await this.authority(tx, current.plan as unknown as Plan);
      } catch {
        ready = false;
      }
      const updated = await tx.custodyExecution.update({
        where: { id: current.id },
        data: {
          state: ready ? 'queued' : 'attention',
          signer_result: json(result),
          revision: { increment: 1 },
          next_check_at: new Date(),
          last_error: ready
            ? null
            : 'Custody policy paused after signing; bytes and source fence retained',
        },
      });
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: ready ? 'queued' : 'attention',
          signed: json(result.signed),
          tx_hash: result.signed.txHash,
          broadcast_generation: 1,
        },
      });
      if (ready) await this.queueSigned(tx, current, request, result);
      await this.emitAttempt(tx, updated, false);
    });
  }

  private async queueSigned(
    tx: Prisma.TransactionClient,
    current: CustodyExecution,
    request: SignRequest | TokenSignRequest,
    result: Extract<Result, { type: 'transaction.custody.signed' }>,
  ) {
    await enqueue(
      tx,
      QUEUES.broadcast,
      {
        type: 'broadcast.requested',
        transactionId: current.transaction_id,
        generation: 1,
        snapshot: {
          chain: request.wallet.chain,
          network: request.wallet.network!,
          signed: result.signed,
          ...(request.transaction.chain === 'solana'
            ? { lastValidBlockHeight: request.transaction.lastValidBlockHeight }
            : {}),
          execution: {
            domainId: current.domain_id,
            resetEpoch: current.reset_epoch,
            operationId: current.operation_id,
            attemptId: current.attempt_id,
            requestDigest: current.request_digest,
            preparationDigest: current.preparation_digest!,
            preparedRequest: request,
            ...(this.tokenPreparation(current)
              ? { tokenPreparation: this.tokenPreparation(current) }
              : {}),
            signerAttestation: result.signerAttestation,
          },
        },
      },
      `custody-broadcast:${current.attempt_id}`,
    );
  }

  private async resumeSigned(execution: CustodyExecution) {
    if (
      execution.reversed ||
      execution.retired_at ||
      !execution.signer_result ||
      execution.state !== 'attention'
    )
      return;
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      if (
        current.reversed ||
        current.retired_at ||
        !current.signer_result ||
        current.state !== 'attention'
      )
        return;
      if (
        await tx.outbox.findUnique({
          where: { dedupe_key: `custody-broadcast:${current.attempt_id}` },
        })
      )
        return;
      try {
        await this.authority(tx, current.plan as unknown as Plan);
      } catch {
        return;
      }
      const result = messageSchema.parse(current.signer_result);
      if (result.type !== 'transaction.custody.signed')
        throw new ActionRejectedError('Persisted Signer result mismatch');
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: current.transaction_id },
      });
      if (canonical(transaction.signed) !== canonical(result.signed))
        throw new ActionRejectedError('Persisted signed custody bytes changed');
      const updated = await tx.custodyExecution.update({
        where: { id: current.id },
        data: {
          state: 'queued',
          revision: { increment: 1 },
          last_error: null,
          next_check_at: new Date(),
        },
      });
      await tx.transaction.update({
        where: { id: transaction.id },
        data: { status: 'queued', last_error: null },
      });
      await this.queueSigned(tx, current, this.request(current), result);
      await this.emitAttempt(tx, updated, false);
    });
  }

  private async ledgerResult(
    event: Extract<ExchangeEvent, { type: 'settlement.committed.v1' | 'settlement.reversed.v1' }>,
    execution: CustodyExecution,
  ) {
    this.checkIdentity(execution, event);
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      if (event.revision <= current.ledger_ack_revision) return;
      if (event.revision < current.settlement_revision) return;
      if (event.type === 'settlement.committed.v1') {
        const transaction = await tx.transaction.findUniqueOrThrow({
          where: { id: current.transaction_id },
        });
        if (event.data.transactionHash !== transaction.tx_hash)
          throw new ActionRejectedError('Ledger settlement does not match canonical execution');
        if (current.reversed) return;
        if (event.revision !== current.settlement_revision)
          throw new Error('Canonical execution has not reached this settlement revision');
        await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            ledger_ack_revision: event.revision,
            ledger_batch_id: event.data.ledgerBatchId,
            next_check_at: new Date(),
          },
        });
      } else {
        if (!current.reversed || event.revision !== current.settlement_revision)
          throw new Error('Canonical reversal has not reached this settlement revision');
        await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            ledger_ack_revision: event.revision,
            ledger_batch_id: event.data.ledgerBatchId,
            next_check_at: new Date(),
            last_error: 'Custody settlement reversed; reconciliation required',
          },
        });
      }
    });
    await this.reconcile(execution.transaction_id);
  }

  async reconcile(transactionId: string) {
    const execution = await this.db.custodyExecution.findUnique({
      where: { transaction_id: transactionId },
    });
    if (
      !execution ||
      execution.reset_epoch !== this.auth.resetEpoch ||
      execution.domain_id !== this.walletConfig.domainId ||
      !this.config.enabled
    )
      return;
    if (execution.state === 'planning') {
      await this.prepare(execution);
      return;
    }
    if (execution.state === 'prepared') {
      if (execution.expires_at && execution.expires_at.getTime() <= Date.now())
        await this.unsignedFailure(
          execution,
          'preparation_expired',
          'Unsigned preparation expired',
        );
      return;
    }
    const transaction = await this.db.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    if (!transaction.signed || !execution.prepared_request) {
      await this.db.custodyExecution.update({
        where: { id: execution.id },
        data: { next_check_at: new Date(Date.now() + this.config.pollIntervalMs) },
      });
      return;
    }
    const request = this.request(execution);
    let observation;
    try {
      const token = this.tokenPreparation(execution);
      observation = token
        ? await new TokenObserver(this.rpc).observe(
            token,
            signedSchema.parse(transaction.signed),
            execution.inclusion && !execution.reversed
              ? (execution.inclusion as { blockHash: string; blockHeight: string })
              : undefined,
          )
        : await this.planner.observe({
            chain: request.wallet.chain as 'ethereum' | 'bitcoin' | 'solana',
            network: request.wallet.network!,
            hash: transaction.tx_hash!,
            request: signSchema.parse(request),
            signed: signedSchema.parse(transaction.signed),
            ...(execution.inclusion && !execution.reversed
              ? {
                  priorInclusion: execution.inclusion as { blockHash: string; blockHeight: string },
                }
              : {}),
          });
    } catch {
      await this.db.custodyExecution.update({
        where: { id: execution.id },
        data: {
          next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
          last_error: 'RPC evidence unavailable; prior inclusion and resources retained',
        },
      });
      return;
    }
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${execution.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
      // RPC reads happen outside the source lock. A newer outcome/ack must win over this snapshot.
      if (
        current.revision !== execution.revision ||
        current.settlement_revision !== execution.settlement_revision ||
        current.ledger_ack_revision !== execution.ledger_ack_revision ||
        current.reversed !== execution.reversed ||
        canonical(current.inclusion) !== canonical(execution.inclusion)
      )
        return;
      await tx.custodyExecution.update({
        where: { id: current.id },
        data: { next_check_at: new Date(Date.now() + this.config.pollIntervalMs) },
      });
      if (observation.state === 'pending') return;
      if (observation.state === 'reverted') {
        if (current.reversed) return;
        await tx.tokenFeeReservation.updateMany({
          where: {
            state: 'settled',
            OR: [
              { id: current.operation_id },
              { request: { path: ['operationId'], equals: current.operation_id } },
            ],
          },
          data: { state: 'reverted', actual_units: null, settled_at: null },
        });
        const other = await tx.custodyExecution.findFirst({
          where: {
            source_wallet_id: current.source_wallet_id,
            retired_at: null,
            id: { not: current.id },
          },
        });
        const updated = await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            state: 'attention',
            reversed: true,
            ...(!other ? { retired_at: null } : {}),
            revision: { increment: 1 },
            settlement_revision: { increment: 1 },
            last_error: 'Canonical inclusion orphaned; source retained for reconciliation',
          },
        });
        if (!other) {
          await tx.transaction.update({
            where: { id: transactionId },
            data: { status: 'attention' },
          });
          const claims = await tx.executionResourceClaim.findMany({
            where: { execution_id: current.id },
          });
          for (const claim of claims) {
            if (
              !(await tx.executionResourceClaim.findFirst({
                where: { resource_key: claim.resource_key, active: true, id: { not: claim.id } },
              }))
            )
              await tx.executionResourceClaim.update({
                where: { id: claim.id },
                data: { active: true, released_at: null },
              });
          }
        }
        await tx.custodyDomain.update({
          where: { id: current.domain_id },
          data: { status: 'paused' },
        });
        if (current.settlement_revision > 0)
          await enqueueFanOut(
            tx,
            this.output(
              updated,
              'settlement.reverted.v1',
              {
                priorSettlementRevision: current.settlement_revision,
                reason: updated.last_error,
              },
              updated.settlement_revision,
            ),
            [QUEUES.ledger],
          );
        await this.emitAttempt(tx, updated, false);
        return;
      }
      if (
        !observation.blockHash ||
        !observation.blockHeight ||
        observation.actualFeeUnits === undefined
      )
        return;
      const inclusion = {
        blockHash: observation.blockHash,
        blockHeight: observation.blockHeight,
        feeUnits: observation.actualFeeUnits,
        outcome: observation.state,
      };
      const changed =
        current.reversed ||
        !current.inclusion ||
        canonical(current.inclusion) !== canonical(inclusion);
      let updated = current;
      if (changed) {
        updated = await tx.custodyExecution.update({
          where: { id: current.id },
          data: {
            state: observation.state,
            revision: { increment: 1 },
            settlement_revision: { increment: 1 },
            inclusion: json(inclusion),
            reversed: false,
            last_error: null,
          },
        });
        await tx.transaction.update({
          where: { id: transactionId },
          data: { status: observation.state },
        });
        const plan = current.plan as unknown as Plan;
        await this.emitAttempt(tx, updated, false);
        await enqueueFanOut(
          tx,
          this.output(
            updated,
            'settlement.requested.v1',
            {
              transactionHash: transaction.tx_hash,
              actualFees:
                BigInt(observation.actualFeeUnits) > 0n
                  ? [
                      {
                        asset: {
                          chain: plan.data.asset.chain,
                          network: plan.data.asset.network,
                          assetId: `token:${plan.data.asset.chain}:native`,
                        },
                        amount: observation.actualFeeUnits,
                      },
                    ]
                  : [],
              ...('actualRentUnits' in observation
                ? { actualRentUnits: observation.actualRentUnits }
                : {}),
              outcome: observation.state === 'confirmed' ? 'confirmed' : 'failed',
            },
            updated.settlement_revision,
          ),
          [QUEUES.ledger],
        );
      }
      if (
        updated.ledger_ack_revision === updated.settlement_revision &&
        updated.ledger_ack_revision > 0 &&
        !updated.reversed &&
        updated.terminal_proof_revision < updated.settlement_revision
      ) {
        if (
          this.tokenPreparation(updated) ||
          (updated.plan as unknown as Plan).type === 'funding.plan.requested.v1'
        ) {
          const rent =
            'actualRentUnits' in observation
              ? BigInt(
                  typeof observation.actualRentUnits === 'string'
                    ? observation.actualRentUnits
                    : '0',
                )
              : 0n;
          await tx.tokenFeeReservation.updateMany({
            where: {
              state: { in: ['uncertain', 'reverted'] },
              OR: [
                { id: current.operation_id },
                { request: { path: ['operationId'], equals: current.operation_id } },
              ],
            },
            data: {
              state: 'settled',
              actual_units: (
                BigInt(observation.actualFeeUnits ?? '0') +
                rent +
                ((updated.plan as unknown as Plan).type === 'funding.plan.requested.v1' &&
                observation.state === 'confirmed'
                  ? BigInt(updated.principal_units!)
                  : 0n)
              ).toString(),
              settled_at: new Date(),
            },
          });
        }
        const retired = await tx.custodyExecution.update({
          where: { id: updated.id },
          data: {
            retired_at: updated.retired_at ?? new Date(),
            terminal_proof_revision: updated.settlement_revision,
            revision: { increment: 1 },
          },
        });
        await tx.executionResourceClaim.updateMany({
          where: { execution_id: updated.id, active: true },
          data: { active: false, released_at: new Date() },
        });
        await this.emitAttempt(tx, retired, true);
      }
    });
    if (observation.state === 'pending') await this.resumeSigned(execution);
  }

  async retrySigned(transactionId: string, commandId: string) {
    await this.reconcile(transactionId);
    const snapshot = await this.db.custodyExecution.findUnique({
      where: { transaction_id: transactionId },
    });
    if (
      !snapshot ||
      snapshot.domain_id !== this.walletConfig.domainId ||
      snapshot.reset_epoch !== this.auth.resetEpoch
    )
      throw new ActionRejectedError('Execution recovery scope mismatch');
    if (snapshot.retired_at && !snapshot.reversed) return;
    await this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${snapshot.source_wallet_id}`);
      const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: snapshot.id } });
      if (current.retired_at && !current.reversed) return;
      if (!current.signer_result) return; // Reconciliation preserves uncertain signing; this command never signs again.
      // Quarantine stops new authorizations. An operator may only replay already signed bytes under their retained claims.
      const other = await tx.custodyExecution.findFirst({
        where: {
          source_wallet_id: current.source_wallet_id,
          retired_at: null,
          id: { not: current.id },
        },
      });
      if (other) throw new ActionRejectedError('Another execution owns this source fence');
      const claims = await tx.executionResourceClaim.findMany({
        where: { execution_id: current.id },
      });
      if (!claims.length || claims.some((c) => !c.active))
        throw new ActionRejectedError('Original resource claims are not held');
      const original = await tx.outbox.findUniqueOrThrow({
        where: { dedupe_key: `custody-broadcast:${current.attempt_id}` },
      });
      const action = messageSchema.parse(original.payload);
      if (action.type !== 'broadcast.requested' || action.transactionId !== transactionId)
        throw new ActionRejectedError('Original signed dispatch evidence missing');
      await enqueue(tx, QUEUES.broadcast, action, `custody-operator-retry:${commandId}`);
    });
  }

  async repairDue() {
    if (!this.config.enabled) return;
    const due = await this.db.custodyExecution.findMany({
      where: {
        domain_id: this.walletConfig.domainId,
        reset_epoch: this.auth.resetEpoch,
        next_check_at: { lte: new Date() },
        state: { notIn: ['deferred'] },
      },
      orderBy: [{ next_check_at: 'asc' }, { id: 'asc' }],
      take: 40,
    });
    for (const execution of due) {
      try {
        await this.reconcile(execution.transaction_id);
      } catch {
        await this.db.custodyExecution.update({
          where: { id: execution.id },
          data: {
            next_check_at: new Date(Date.now() + this.config.pollIntervalMs),
            last_error: 'Execution reconciliation failed; resources retained',
          },
        });
      }
    }
  }
}
