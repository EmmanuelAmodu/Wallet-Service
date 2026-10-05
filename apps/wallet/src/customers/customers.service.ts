import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExchangeCustomer, ExchangeDepositAddressAssignment, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { canonical, MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue, enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Chain, chainSchema, isEvmChain } from '../../../../packages/shared/src/contracts.js';
import { exchangeApiConfig, ExchangeApiSettings } from '../config/exchange-api.config.js';
import { LedgerClient } from '../ledger/ledger-client.service.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { CustodyService } from '../custody/custody.service.js';

type DepositEvent = Extract<ExchangeEvent, { type: `deposit.${string}` }>;
type AssignmentView = {
  assignmentId: string;
  customerId: string;
  chain: string;
  network: string;
} & (
  | { state: 'waiting'; reason: string }
  | { state: 'ready'; walletId: string; address: string; registryRevision: number }
);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

@Injectable()
export class ExchangeCustomersService {
  constructor(
    @Inject(WalletPrismaService) private readonly db: WalletPrismaService,
    @Inject(exchangeApiConfig.KEY) private readonly settings: ExchangeApiSettings,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @Inject(LedgerClient) private readonly ledger: LedgerClient,
    @Optional() private readonly custody?: CustodyService,
  ) {}

  private domain() {
    if (!this.settings.domainId)
      throw new ServiceUnavailableException('Exchange backend API is not configured');
    return this.settings.domainId;
  }

  private async customer(db: Prisma.TransactionClient, customerId: string) {
    const row = await db.exchangeCustomer.findUnique({ where: { customer_id: customerId } });
    if (!row || row.domain_id !== this.domain() || row.reset_epoch !== this.auth.resetEpoch)
      throw new NotFoundException('Customer not found');
    return row;
  }

  async create(externalId: string) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(externalId))
      throw new ConflictException('User UUID registration must originate in User service');
    const domainId = this.domain();
    return this.db.$transaction(async (db) => {
      await lock(db, `exchange-customer-external:${digest(externalId)}`);
      let customer = await db.exchangeCustomer.findUnique({ where: { external_id: externalId } });
      if (
        customer &&
        (customer.domain_id !== domainId || customer.reset_epoch !== this.auth.resetEpoch)
      )
        throw new ConflictException('Customer identity belongs to another custody domain or epoch');
      customer ??= await db.exchangeCustomer.create({
        data: {
          customer_id: randomUUID(),
          external_id: externalId,
          domain_id: domainId,
          reset_epoch: this.auth.resetEpoch,
        },
      });
      await this.registerIdentity(db, customer);
      return {
        customerId: customer.customer_id,
        externalId: customer.external_id,
        state: customer.state,
      };
    });
  }

  async registerUser(
    event: Extract<ExchangeEvent, { type: 'user.registered.v1' }>,
    db: Prisma.TransactionClient,
  ) {
    if (event.domainId !== this.domain() || event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('User registration domain or epoch mismatch');
    const userId = event.data.userId;
    await lock(db, `exchange-customer-external:${digest(userId)}`);
    await lock(db, `exchange-customer:${userId}`);
    const external = await db.exchangeCustomer.findUnique({ where: { external_id: userId } });
    const existing = await db.exchangeCustomer.findUnique({ where: { customer_id: userId } });
    for (const customer of [external, existing])
      if (
        customer &&
        (customer.customer_id !== userId ||
          customer.external_id !== userId ||
          customer.domain_id !== event.domainId ||
          customer.reset_epoch !== event.resetEpoch)
      )
        throw new ActionRejectedError('User identity conflicts with existing customer ownership');
    const customer =
      existing ??
      (await db.exchangeCustomer.create({
        data: {
          customer_id: userId,
          external_id: userId,
          domain_id: event.domainId,
          reset_epoch: event.resetEpoch,
        },
      }));
    await this.registerIdentity(db, customer);
  }

  private async registerIdentity(db: Prisma.TransactionClient, customer: ExchangeCustomer) {
    const eventHash = digest([
      'customer.registry.requested.v1',
      customer.customer_id,
      customer.domain_id,
      customer.reset_epoch,
    ]);
    const eventId = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-8${eventHash.slice(13, 16)}-a${eventHash.slice(17, 20)}-${eventHash.slice(20, 32)}`;
    // Reconstruct the same immutable command on replay so a missing delivery can recover.
    const registration = exchangeEventSchema.parse({
      eventId,
      schemaVersion: 1,
      resetEpoch: customer.reset_epoch,
      occurredAt: customer.created_at.toISOString(),
      domainId: customer.domain_id,
      correlationId: customer.customer_id,
      causationId: customer.external_id === customer.customer_id ? customer.customer_id : null,
      aggregateId: customer.customer_id,
      revision: 1,
      customerId: customer.customer_id,
      type: 'customer.registry.requested.v1',
      data: { externalId: customer.external_id },
    });
    await enqueueFanOut(db, registration, [QUEUES.ledger]);
  }

  async get(customerId: string) {
    const customer = await this.customer(this.db, customerId);
    return { customerId, externalId: customer.external_id, state: customer.state };
  }

  async assign(customerId: string, chain: Chain, network: string) {
    this.custody?.validateNetwork(chain, network);
    return this.db.$transaction(async (db) => {
      await this.customer(db, customerId);
      await lock(db, `exchange-assignment:${customerId}:${chain}:${network}`);
      let assignment = await db.exchangeDepositAddressAssignment.findUnique({
        where: { customer_id_chain_network: { customer_id: customerId, chain, network } },
      });
      if (!assignment)
        assignment = await db.exchangeDepositAddressAssignment.create({
          data: {
            assignment_id: randomUUID(),
            customer_id: customerId,
            domain_id: this.domain(),
            reset_epoch: this.auth.resetEpoch,
            chain,
            network,
          },
        });
      await this.bindRegisteredWallet(db, assignment);
      if (this.custody)
        await enqueue(
          db,
          QUEUES.wallet,
          {
            type: 'custody.assignment.issue',
            commandId: assignment.assignment_id,
            domainId: assignment.domain_id,
            assignmentId: assignment.assignment_id,
          },
          `assignment-issue-${assignment.assignment_id}`,
        );
      return this.assignmentView(db, assignment.assignment_id, customerId);
    });
  }

  async issueAssignment(assignmentId: string, domainId: string) {
    if (!this.custody) throw new Error('Custody issuance service is unavailable');
    if (domainId !== this.domain()) throw new ActionRejectedError('Custody domain mismatch');
    return this.db.$transaction(async (db) => {
      const assignment = await db.exchangeDepositAddressAssignment.findUnique({
        where: { assignment_id: assignmentId },
      });
      if (
        !assignment ||
        assignment.domain_id !== domainId ||
        assignment.reset_epoch !== this.auth.resetEpoch
      )
        throw new ActionRejectedError('Address assignment domain or epoch mismatch');
      await lock(
        db,
        `exchange-assignment:${assignment.customer_id}:${assignment.chain}:${assignment.network}`,
      );
      await this.customer(db, assignment.customer_id);
      const wallet = await this.custody!.allocateCustomer(
        db,
        assignment.customer_id,
        chainSchema.parse(assignment.chain),
        assignment.network,
      );
      if (assignment.wallet_id && assignment.wallet_id !== wallet.id)
        throw new ActionRejectedError('Address assignment ownership is immutable');
      await db.exchangeDepositAddressAssignment.update({
        where: { assignment_id: assignmentId },
        data: { wallet_id: wallet.id },
      });
    });
  }

  async resumeIssuance(domainId: string, commandId: string) {
    if (domainId !== this.domain()) throw new ActionRejectedError('Custody domain mismatch');
    let after: string | undefined;
    let count = 0;
    for (;;) {
      const page = await this.db.$transaction(async (db) => {
        const assignments = await db.exchangeDepositAddressAssignment.findMany({
          where: {
            domain_id: domainId,
            reset_epoch: this.auth.resetEpoch,
            wallet_id: null,
            ...(after ? { assignment_id: { gt: after } } : {}),
          },
          orderBy: { assignment_id: 'asc' },
          take: 100,
        });
        for (const assignment of assignments)
          await enqueue(
            db,
            QUEUES.wallet,
            {
              type: 'custody.assignment.issue',
              commandId,
              domainId,
              assignmentId: assignment.assignment_id,
            },
            `assignment-issue-${assignment.assignment_id}-${commandId}`,
          );
        return assignments;
      });
      count += page.length;
      if (page.length < 100) return count;
      after = page.at(-1)!.assignment_id;
    }
  }

  async assignment(customerId: string, assignmentId: string) {
    return this.db.$transaction(async (db) => {
      await this.customer(db, customerId);
      const assignment = await db.exchangeDepositAddressAssignment.findUnique({
        where: { assignment_id: assignmentId },
      });
      if (
        !assignment ||
        assignment.customer_id !== customerId ||
        assignment.domain_id !== this.domain() ||
        assignment.reset_epoch !== this.auth.resetEpoch
      )
        throw new NotFoundException('Deposit address assignment not found');
      await lock(db, `exchange-assignment:${customerId}:${assignment.chain}:${assignment.network}`);
      const current = await db.exchangeDepositAddressAssignment.findUniqueOrThrow({
        where: { assignment_id: assignmentId },
      });
      await this.bindRegisteredWallet(db, current);
      return this.assignmentView(db, assignmentId, customerId);
    });
  }

  private async bindRegisteredWallet(
    db: Prisma.TransactionClient,
    assignment: ExchangeDepositAddressAssignment,
  ) {
    if (assignment.wallet_id) return;
    const registered = await db.exchangeWalletRegistry.findMany({
      where: {
        domain_id: this.domain(),
        reset_epoch: this.auth.resetEpoch,
        customer_id: assignment.customer_id,
        chain: assignment.chain,
        network: assignment.network,
        role: 'customer_deposit',
        account: { gte: 10 },
      },
      take: 2,
    });
    if (registered.length > 1)
      throw new ConflictException('Customer wallet registry ownership is ambiguous');
    if (registered.length === 1)
      if (
        await db.wallet.findFirst({
          where: {
            id: registered[0].wallet_id,
            custody_domain_id: assignment.domain_id,
            reset_epoch: assignment.reset_epoch,
            customer_id: assignment.customer_id,
            custody_role: 'customer_deposit',
            active: true,
            chain: assignment.chain,
            network: assignment.network,
          },
        })
      )
        await db.exchangeDepositAddressAssignment.update({
          where: { assignment_id: assignment.assignment_id },
          data: { wallet_id: registered[0].wallet_id },
        });
  }

  private async assignmentView(
    db: Prisma.TransactionClient,
    assignmentId: string,
    customerId: string,
  ): Promise<AssignmentView> {
    const assignment = await db.exchangeDepositAddressAssignment.findUnique({
      where: { assignment_id: assignmentId },
    });
    if (
      !assignment ||
      assignment.customer_id !== customerId ||
      assignment.domain_id !== this.domain() ||
      assignment.reset_epoch !== this.auth.resetEpoch
    )
      throw new NotFoundException('Deposit address assignment not found');
    const base = { assignmentId, customerId, chain: assignment.chain, network: assignment.network };
    const owner = await this.customer(db, customerId);
    if (owner.ledger_status !== 'ready')
      return { ...base, state: 'waiting', reason: 'customer_ledger_not_ready' };
    if (!assignment.wallet_id)
      return { ...base, state: 'waiting', reason: 'custody_bootstrap_required' };
    const owned = await db.wallet.findUnique({ where: { id: assignment.wallet_id } });
    if (
      !owned ||
      !owned.active ||
      owned.custody_domain_id !== assignment.domain_id ||
      owned.reset_epoch !== assignment.reset_epoch ||
      owned.customer_id !== customerId ||
      owned.custody_role !== 'customer_deposit' ||
      owned.account < 10 ||
      owned.chain !== assignment.chain ||
      owned.network !== assignment.network
    )
      throw new ConflictException('Deposit address has no authoritative custody ownership');
    if (owned.status !== 'ready' || !owned.address || !owned.published_at)
      return { ...base, state: 'waiting', reason: 'address_derivation_not_ready' };
    if (!this.custody || !(await this.custody.publicationAllowed(db, owned)))
      return { ...base, state: 'waiting', reason: 'custody_configuration_not_ready' };
    const identity = await db.exchangeWalletRegistry.findUnique({
      where: { wallet_id: assignment.wallet_id },
    });
    if (!identity) return { ...base, state: 'waiting', reason: 'registry_subscription_not_ready' };
    const requiresManagement =
      isEvmChain(chainSchema.parse(assignment.chain)) || assignment.chain === 'solana';
    const managementCandidates = requiresManagement
      ? await db.exchangeWalletRegistry.findMany({
          where: {
            domain_id: assignment.domain_id,
            reset_epoch: assignment.reset_epoch,
            chain: assignment.chain,
            network: assignment.network,
            role: 'management',
            account: 1,
          },
          take: 2,
        })
      : [];
    // Serialize the publication decision with all custody registries' acknowledgment/rebuild updates.
    for (const walletId of [
      ...new Set([
        assignment.wallet_id,
        ...(identity?.hot_wallet_id ? [identity.hot_wallet_id] : []),
        ...managementCandidates.map((row) => row.wallet_id),
      ]),
    ].sort())
      await lock(db, `exchange-registry:${walletId}`);
    const wallet = await db.exchangeWalletRegistry.findUnique({
      where: { wallet_id: assignment.wallet_id },
    });
    if (wallet?.hot_wallet_id !== identity?.hot_wallet_id)
      throw new ConflictException('Deposit wallet registry changed during address assignment');
    if (
      wallet &&
      (wallet.address !== owned.address ||
        wallet.account !== owned.account ||
        wallet.hot_wallet_id !== owned.hot_wallet_id ||
        wallet.registry_revision !== owned.registry_revision)
    )
      throw new ConflictException('Published address differs from its authoritative wallet');
    if (
      !wallet ||
      wallet.domain_id !== assignment.domain_id ||
      wallet.reset_epoch !== assignment.reset_epoch ||
      wallet.customer_id !== customerId ||
      wallet.chain !== assignment.chain ||
      wallet.network !== assignment.network ||
      wallet.role !== 'customer_deposit' ||
      wallet.account < 10
    )
      throw new ConflictException('Deposit wallet registry ownership is inconsistent');
    const hot = wallet.hot_wallet_id
      ? await db.exchangeWalletRegistry.findUnique({ where: { wallet_id: wallet.hot_wallet_id } })
      : null;
    if (
      !hot ||
      hot.domain_id !== assignment.domain_id ||
      hot.reset_epoch !== assignment.reset_epoch ||
      hot.chain !== assignment.chain ||
      hot.network !== assignment.network ||
      hot.role !== 'hot' ||
      hot.account !== 0 ||
      hot.customer_id ||
      hot.ledger_status !== 'ready' ||
      hot.ledger_ack_revision <= 0
    )
      return { ...base, state: 'waiting', reason: 'hot_wallet_not_ready' };
    const ownedHot = await db.wallet.findUnique({ where: { id: hot.wallet_id } });
    if (
      !ownedHot ||
      !ownedHot.active ||
      ownedHot.custody_role !== 'hot' ||
      ownedHot.account !== 0 ||
      ownedHot.custody_domain_id !== owned.custody_domain_id ||
      ownedHot.reset_epoch !== owned.reset_epoch ||
      ownedHot.seed_id !== owned.seed_id ||
      ownedHot.chain !== owned.chain ||
      ownedHot.network !== owned.network ||
      ownedHot.address !== hot.address ||
      !ownedHot.published_at ||
      ownedHot.registry_revision !== hot.registry_revision
    )
      return { ...base, state: 'waiting', reason: 'hot_wallet_not_ready' };
    if (requiresManagement) {
      const management =
        managementCandidates.length === 1
          ? await db.exchangeWalletRegistry.findUnique({
              where: { wallet_id: managementCandidates[0].wallet_id },
            })
          : null;
      if (
        !management ||
        management.domain_id !== assignment.domain_id ||
        management.reset_epoch !== assignment.reset_epoch ||
        management.chain !== assignment.chain ||
        management.network !== assignment.network ||
        management.role !== 'management' ||
        management.account !== 1 ||
        management.customer_id ||
        management.ledger_status !== 'ready' ||
        management.ledger_ack_revision <= 0
      )
        return { ...base, state: 'waiting', reason: 'management_wallet_not_ready' };
      const ownedManagement = await db.wallet.findUnique({ where: { id: management.wallet_id } });
      if (
        !ownedManagement ||
        !ownedManagement.active ||
        ownedManagement.custody_role !== 'management' ||
        ownedManagement.account !== 1 ||
        ownedManagement.management_purpose !== 'gas_fee' ||
        ownedManagement.custody_domain_id !== owned.custody_domain_id ||
        ownedManagement.reset_epoch !== owned.reset_epoch ||
        ownedManagement.seed_id !== owned.seed_id ||
        ownedManagement.chain !== owned.chain ||
        ownedManagement.network !== owned.network ||
        ownedManagement.address !== management.address ||
        !ownedManagement.published_at ||
        ownedManagement.registry_revision !== management.registry_revision
      )
        return { ...base, state: 'waiting', reason: 'management_wallet_not_ready' };
    }
    if (
      !wallet.ready ||
      wallet.ledger_status !== 'ready' ||
      wallet.listener_status !== 'ready' ||
      wallet.ledger_ack_revision <= 0 ||
      wallet.listener_ack_revision <= 0 ||
      !wallet.start_cursor
    )
      return { ...base, state: 'waiting', reason: 'registry_subscription_not_ready' };
    return {
      ...base,
      state: 'ready',
      walletId: wallet.wallet_id,
      address: wallet.address,
      registryRevision: wallet.registry_revision,
    };
  }

  async balances(customerId: string) {
    const customer = await this.customer(this.db, customerId);
    if (customer.ledger_status !== 'ready')
      return { customerId, state: 'awaiting_ledger_registration' as const };
    return this.ledger.exchangeBalances(this.domain(), customerId);
  }

  async deposits(customerId: string, cursor?: string, limit = 50) {
    await this.customer(this.db, customerId);
    if (cursor) {
      const previous = await this.db.exchangeDepositProjection.findUnique({
        where: { deposit_id: cursor },
      });
      if (
        !previous ||
        previous.customer_id !== customerId ||
        previous.domain_id !== this.domain() ||
        previous.reset_epoch !== this.auth.resetEpoch
      )
        throw new NotFoundException('Deposit history cursor not found');
    }
    const rows = await this.db.exchangeDepositProjection.findMany({
      where: {
        customer_id: customerId,
        domain_id: this.domain(),
        reset_epoch: this.auth.resetEpoch,
      },
      ...(cursor ? { cursor: { deposit_id: cursor }, skip: 1 } : {}),
      orderBy: [{ created_at: 'desc' }, { deposit_id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      customerId,
      deposits: page.map((row) => ({
        depositId: row.deposit_id,
        walletId: row.wallet_id,
        asset: { chain: row.chain, network: row.network, assetId: row.asset_id },
        amount: row.amount,
        transactionHash: row.transaction_hash,
        transferIdentity: row.transfer_identity,
        discoveryState: row.discovery_state,
        state: row.accounting_state,
        ledgerBatchId: row.ledger_batch_id,
        deficitIncidentId: row.deficit_incident_id,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? page.at(-1)!.deposit_id : null,
    };
  }

  // Called inside Wallet's consumer inbox transaction; no financial decisions are made here.
  async project(input: ExchangeEvent, transaction?: Prisma.TransactionClient) {
    const event = exchangeEventSchema.parse(input);
    if (event.type === 'customer.registry.acknowledged.v1') {
      const apply = async (db: Prisma.TransactionClient) => {
        if (
          event.resetEpoch !== this.auth.resetEpoch ||
          (this.settings.domainId && event.domainId !== this.settings.domainId)
        )
          throw new ActionRejectedError('Customer registry acknowledgment domain/epoch mismatch');
        await lock(db, `exchange-customer:${event.customerId}`);
        const customer = await db.exchangeCustomer.findUnique({
          where: { customer_id: event.customerId },
        });
        if (!customer) throw new Error('Customer identity has not committed yet');
        if (
          customer.domain_id !== event.domainId ||
          customer.reset_epoch !== event.resetEpoch ||
          customer.external_id !== event.data.externalId
        )
          throw new ActionRejectedError('Customer registry acknowledgment identity mismatch');
        if (event.revision > customer.ledger_registry_revision)
          await db.exchangeCustomer.update({
            where: { customer_id: event.customerId },
            data: { ledger_status: event.data.status, ledger_registry_revision: event.revision },
          });
      };
      if (transaction) await apply(transaction);
      else await this.db.$transaction(apply);
      return;
    }
    if (
      event.type === 'custody.loss.recorded.v1' ||
      event.type === 'custody.loss.reverted.v1' ||
      (event.type === 'custody.incident.opened.v1' &&
        event.customerId &&
        ['high', 'critical'].includes(event.data.severity))
    ) {
      const applyIncident = async (db: Prisma.TransactionClient) => {
        if (
          event.resetEpoch !== this.auth.resetEpoch ||
          (this.settings.domainId && event.domainId !== this.settings.domainId)
        )
          throw new ActionRejectedError('Customer incident projection domain/epoch mismatch');
        await lock(db, `exchange-customer:${event.customerId}`);
        const customer = await db.exchangeCustomer.findUnique({
          where: { customer_id: event.customerId! },
        });
        if (!customer) throw new Error('Customer identity has not committed yet');
        if (customer.domain_id !== event.domainId || customer.reset_epoch !== event.resetEpoch)
          throw new ActionRejectedError('Customer incident ownership mismatch');
        if (event.type !== 'custody.incident.opened.v1') {
          const registry = await db.exchangeWalletRegistry.findUnique({
            where: { wallet_id: event.data.walletId },
          });
          if (!registry) throw new Error('Custody loss wallet registry has not committed yet');
          if (
            registry.customer_id !== event.customerId ||
            registry.domain_id !== event.domainId ||
            registry.reset_epoch !== event.resetEpoch ||
            registry.role !== 'customer_deposit' ||
            registry.account < 10 ||
            registry.chain !== event.data.asset.chain ||
            registry.network !== event.data.asset.network
          )
            throw new ActionRejectedError('Custody loss wallet ownership mismatch');
        }
        // Reorg recovery does not undo an operational freeze; operator reconciliation owns thawing.
        await db.exchangeCustomer.update({
          where: { customer_id: event.customerId! },
          data: { state: 'frozen' },
        });
      };
      if (transaction) await applyIncident(transaction);
      else await this.db.$transaction(applyIncident);
      return;
    }
    if (!event.type.startsWith('deposit.')) return;
    if (
      event.resetEpoch !== this.auth.resetEpoch ||
      (this.settings.domainId && event.domainId !== this.settings.domainId)
    )
      throw new ActionRejectedError('Deposit projection domain/epoch mismatch');
    const deposit = event as DepositEvent;
    const apply = async (db: Prisma.TransactionClient) => {
      await lock(db, `exchange-customer:${deposit.customerId}`);
      const customer = await db.exchangeCustomer.findUnique({
        where: { customer_id: deposit.customerId },
      });
      if (!customer) throw new Error('Customer identity has not committed yet');
      if (customer.domain_id !== event.domainId || customer.reset_epoch !== event.resetEpoch)
        throw new ActionRejectedError('Deposit customer ownership mismatch');
      await lock(db, `exchange-deposit-projection:${deposit.data.depositId}`);
      const current = await db.exchangeDepositProjection.findUnique({
        where: { deposit_id: deposit.data.depositId },
      });
      const data = deposit.data;
      const walletId = 'walletId' in data ? data.walletId : undefined;
      const amount = 'amount' in data ? data.amount : undefined;
      const hash = 'transactionHash' in data ? data.transactionHash : undefined;
      const transfer = 'transferIdentity' in data ? data.transferIdentity : undefined;
      // Deficit amount is the shortfall; it must never overwrite the original deposit amount.
      const principal = deposit.type === 'deposit.deficit-recorded.v1' ? undefined : amount;
      if (
        current &&
        (current.customer_id !== deposit.customerId ||
          current.domain_id !== deposit.domainId ||
          current.reset_epoch !== deposit.resetEpoch ||
          current.chain !== data.asset.chain ||
          current.network !== data.asset.network ||
          current.asset_id !== data.asset.assetId ||
          (walletId && current.wallet_id && walletId !== current.wallet_id) ||
          (principal && current.amount && principal !== current.amount) ||
          (hash && current.transaction_hash && hash !== current.transaction_hash) ||
          (transfer &&
            current.transfer_identity &&
            canonical(transfer) !== canonical(current.transfer_identity)))
      )
        throw new ActionRejectedError('Deposit projection identity is immutable');
      if (walletId) {
        const registry = await db.exchangeWalletRegistry.findUnique({
          where: { wallet_id: walletId },
        });
        if (!registry) throw new Error('Deposit wallet registry has not committed yet');
        if (
          registry.customer_id !== deposit.customerId ||
          registry.domain_id !== deposit.domainId ||
          registry.reset_epoch !== deposit.resetEpoch ||
          registry.role !== 'customer_deposit' ||
          registry.account < 10 ||
          registry.chain !== data.asset.chain ||
          registry.network !== data.asset.network
        )
          throw new ActionRejectedError('Deposit wallet ownership mismatch');
      }
      const row =
        current ??
        (await db.exchangeDepositProjection.create({
          data: {
            deposit_id: data.depositId,
            customer_id: deposit.customerId,
            domain_id: deposit.domainId,
            reset_epoch: deposit.resetEpoch,
            chain: data.asset.chain,
            network: data.asset.network,
            asset_id: data.asset.assetId,
          },
        }));
      const common: Prisma.ExchangeDepositProjectionUpdateInput = {
        ...(walletId ? { wallet_id: walletId } : {}),
        ...(principal ? { amount: principal } : {}),
        ...(hash ? { transaction_hash: hash } : {}),
        ...(transfer ? { transfer_identity: transfer } : {}),
      };
      if (deposit.type === 'deposit.deficit-recorded.v1') {
        await db.exchangeCustomer.update({
          where: { customer_id: deposit.customerId },
          data: { state: 'frozen' },
        });
        await db.exchangeDepositProjection.update({
          where: { deposit_id: row.deposit_id },
          data: {
            ...common,
            deficit_incident_id: deposit.data.incidentId,
            reason: deposit.data.reason,
          },
        });
        return;
      }
      const accounting =
        deposit.type === 'deposit.credited.v1' || deposit.type === 'deposit.reversed.v1';
      const previousRevision = accounting ? row.accounting_revision : row.discovery_revision;
      const contentDigest = digest({ type: deposit.type, data: deposit.data });
      const previousDigest = accounting ? row.accounting_digest : row.discovery_digest;
      if (deposit.revision === previousRevision && previousDigest !== contentDigest)
        throw new ActionRejectedError('Deposit projection revision reused with different content');
      if (deposit.revision > previousRevision) {
        if (accounting) {
          common.accounting_revision = deposit.revision;
          common.accounting_digest = contentDigest;
          common.accounting_state =
            deposit.type === 'deposit.credited.v1' ? 'credited' : 'reversed';
          common.ledger_batch_id = 'ledgerBatchId' in data ? data.ledgerBatchId : undefined;
          if (deposit.type === 'deposit.reversed.v1') {
            common.reason = deposit.data.reason;
            if (deposit.data.deficitIncidentId) {
              common.deficit_incident_id = deposit.data.deficitIncidentId;
              await db.exchangeCustomer.update({
                where: { customer_id: deposit.customerId },
                data: { state: 'frozen' },
              });
            }
          }
        } else {
          common.discovery_revision = deposit.revision;
          common.discovery_digest = contentDigest;
          common.discovery_state =
            deposit.type === 'deposit.observed.v1'
              ? 'observed'
              : deposit.type === 'deposit.finalized.v1'
                ? 'finalized'
                : 'reverted';
          if (transfer && hash && principal && walletId)
            common.identity_digest = digest({
              customerId: deposit.customerId,
              walletId,
              asset: data.asset,
              transfer,
              hash,
              amount: principal,
            });
        }
      }
      await db.exchangeDepositProjection.update({
        where: { deposit_id: row.deposit_id },
        data: common,
      });
    };
    if (transaction) await apply(transaction);
    else await this.db.$transaction(apply);
  }
}
