import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Prisma } from '@prisma/client';
import type { ExchangeWalletRegistration, Prisma as ActivityPrisma } from '.prisma/activity-client';
import { ActivityPrismaService } from '../prisma/prisma.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import {
  canonical,
  MessageAuth,
  Message,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue, enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { isEvmChain } from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  ExchangeWatchProvider,
  EXCHANGE_WATCH_PROVIDER,
  ProviderWatchIdentity,
  ProviderInstallRequest,
  providerInstallAcknowledgmentSchema,
  providerBackfillPageSchema,
  providerRemoveAcknowledgmentSchema,
} from '../provider/provider.contracts.js';

type RegistryRequest = Extract<
  ExchangeEvent,
  { type: 'customer-wallet.registry.requested.v1' | 'custody-wallet.registry.requested.v1' }
>;
type Transaction = ActivityPrisma.TransactionClient;
const activityDbNull = createRequire(import.meta.url)('.prisma/activity-client').Prisma
  .DbNull as ActivityPrisma.NullableJsonNullValueInput;

@Injectable()
export class ActivityRegistryService {
  constructor(
    @Inject(ActivityPrismaService) private readonly db: ActivityPrismaService,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @Optional() @Inject(EXCHANGE_WATCH_PROVIDER) private readonly provider?: ExchangeWatchProvider,
  ) {}

  async register(input: RegistryRequest) {
    const event = exchangeEventSchema.parse(input) as RegistryRequest;
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale registry epoch');
    const data = event.data;
    const address = isEvmChain(data.chain) ? data.address.toLowerCase() : data.address;
    const role =
      event.type === 'customer-wallet.registry.requested.v1' ? 'customer_deposit' : event.data.role;
    const customerId =
      event.type === 'customer-wallet.registry.requested.v1' ? event.customerId : null;
    const hotWalletId =
      event.type === 'customer-wallet.registry.requested.v1' ? event.data.hotWalletId : null;
    const inboxId = `activity-listener:${event.eventId}`;
    const payloadHash = createHash('sha256').update(canonical(event)).digest('hex');
    await this.db.$transaction(async (db) => {
      await lock(db, inboxId);
      const seen = await db.inbox.findUnique({ where: { id: inboxId } });
      if (seen) {
        if (seen.payload_hash !== payloadHash)
          throw new ActionRejectedError('Event identity reused with different content');
        return;
      }
      await lock(db, `registry:${data.walletId}`);
      const current = await db.exchangeWalletRegistration.findUnique({
        where: { wallet_id: data.walletId },
      });
      if (
        current &&
        (current.domain_id !== event.domainId ||
          current.reset_epoch !== event.resetEpoch ||
          current.chain !== data.chain ||
          current.network !== data.network ||
          current.address !== address ||
          current.role !== role ||
          current.account !== data.account ||
          current.customer_id !== customerId ||
          current.hot_wallet_id !== hotWalletId)
      )
        throw new ActionRejectedError('Published wallet registry identity is immutable');
      if (
        current &&
        data.registryRevision === current.registry_revision &&
        canonical((current.request as unknown as RegistryRequest).data) !== canonical(data)
      )
        throw new ActionRejectedError('Registry revision reused with different content');
      // An equal revision replay preserves completed coverage and its acknowledgment sequence.
      if (!current || data.registryRevision > current.registry_revision) {
        const fromCursor =
          event.type === 'customer-wallet.registry.requested.v1'
            ? (event.data.startCursor ?? current?.backfill_cursor ?? null)
            : null;
        const row = await db.exchangeWalletRegistration.upsert({
          where: { wallet_id: data.walletId },
          create: {
            wallet_id: data.walletId,
            domain_id: event.domainId,
            reset_epoch: event.resetEpoch,
            chain: data.chain,
            network: data.network,
            address,
            role,
            account: data.account,
            customer_id: customerId,
            hot_wallet_id: hotWalletId,
            registry_revision: data.registryRevision,
            request: event as unknown as Prisma.InputJsonValue,
            status: role === 'customer_deposit' ? 'awaiting_provider_coverage' : 'ready',
            start_cursor: fromCursor,
            coverage_start_cursor: fromCursor,
          },
          update: {
            registry_revision: data.registryRevision,
            request: event as unknown as Prisma.InputJsonValue,
            status:
              role === 'customer_deposit'
                ? current?.provider_watch_id
                  ? 'rebuilding'
                  : 'awaiting_provider_coverage'
                : 'ready',
            coverage_start_cursor: fromCursor,
            backfill_cursor: null,
            backfill_complete: false,
            provider_error: null,
          },
        });
        await this.acknowledge(
          db,
          row,
          'rejected',
          role === 'customer_deposit'
            ? 'awaiting_phase3_provider_watch_and_backfill_coverage'
            : 'custody_projection_only_no_customer_subscription',
        );
      }
      await db.inbox.create({ data: { id: inboxId, payload_hash: payloadHash } });
    });
    // Side effects occur after durable registration; an interrupted job can retry this same fence.
    const current = await this.row(data.walletId);
    if (
      current.role === 'customer_deposit' &&
      current.registry_revision === data.registryRevision &&
      this.provider?.certified(current.chain, current.network)
    )
      await this.recover(data.walletId);
    return this.row(data.walletId);
  }

  async recover(walletId: string) {
    let current = await this.row(walletId);
    if (current.role !== 'customer_deposit' || current.status === 'removed') return current;
    if (!this.provider?.certified(current.chain, current.network)) {
      // Configuration never substitutes for a coverage acknowledgment.
      if (current.status === 'ready') {
        await this.db.$transaction(async (db) => {
          await lock(db, `registry:${walletId}`);
          const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
            where: { wallet_id: walletId },
          });
          if (!this.sameFence(current, row) || row.status !== 'ready') return;
          const updated = await db.exchangeWalletRegistration.update({
            where: { wallet_id: walletId },
            data: {
              status: 'rebuilding',
              coverage_start_cursor: row.backfill_cursor ?? row.coverage_start_cursor,
              backfill_cursor: null,
              backfill_complete: false,
              provider_error: 'phase3_provider_not_certified',
            },
          });
          await this.acknowledge(db, updated, 'rejected', 'phase3_provider_not_certified');
        });
        return this.row(walletId);
      }
      return current;
    }
    if (current.status === 'ready') return current;
    try {
      if (current.status === 'removing') return await this.finishRemoval(current, false);
      if (current.status === 'rebuilding') current = await this.finishRemoval(current, true);
      if (!current.provider_watch_id) {
        const identity = this.identity(current);
        const installRequest: ProviderInstallRequest = {
          ...identity,
          ...(current.coverage_start_cursor ? { fromCursor: current.coverage_start_cursor } : {}),
        };
        const expected = current;
        const prepared = await this.db.$transaction(async (db) => {
          await lock(db, `registry:${walletId}`);
          const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
            where: { wallet_id: walletId },
          });
          if (
            !this.sameFence(expected, row) ||
            ['rebuilding', 'removing', 'removed', 'ready'].includes(row.status)
          )
            return false;
          const lease = await db.exchangeProviderWatchLease.upsert({
            where: { generation: identity.generation },
            update: {},
            create: {
              generation: identity.generation,
              wallet_id: row.wallet_id,
              domain_id: row.domain_id,
              reset_epoch: row.reset_epoch,
              chain: row.chain,
              network: row.network,
              provider: identity.provider,
              install_request: installRequest as unknown as Prisma.InputJsonValue,
            },
          });
          if (canonical(lease.install_request) !== canonical(installRequest))
            throw new ActionRejectedError('Provider install fence reused with different content');
          if (lease.state === 'cleanup' || lease.state === 'removed') return false;
          await db.exchangeWalletRegistration.update({
            where: { wallet_id: walletId },
            data: { status: 'installing' },
          });
          return true;
        });
        if (!prepared) return this.row(walletId);
        const acknowledgment = providerInstallAcknowledgmentSchema.parse(
          await this.provider.install(installRequest),
        );
        this.match(identity, acknowledgment);
        current = await this.db.$transaction(async (db) => {
          await lock(db, `registry:${walletId}`);
          const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
            where: { wallet_id: walletId },
          });
          const active =
            this.sameFence(expected, row) &&
            !['rebuilding', 'removing', 'removed', 'ready'].includes(row.status);
          const lease = await db.exchangeProviderWatchLease.findUniqueOrThrow({
            where: { generation: identity.generation },
          });
          if (
            lease.watch_id &&
            (lease.watch_id !== acknowledgment.watchId ||
              canonical(lease.acknowledgment) !== canonical(acknowledgment))
          )
            throw new ActionRejectedError(
              'Provider changed installation acknowledgment for the same fence',
            );
          await db.exchangeProviderWatchLease.update({
            where: { generation: identity.generation },
            data: {
              state: active
                ? 'active'
                : lease.state === 'active' &&
                    this.sameFence(expected, row) &&
                    row.status === 'ready'
                  ? 'active'
                  : 'cleanup',
              watch_id: acknowledgment.watchId,
              acknowledgment: acknowledgment as unknown as Prisma.InputJsonValue,
            },
          });
          if (
            !this.sameFence(expected, row) ||
            ['rebuilding', 'removing', 'removed', 'ready'].includes(row.status)
          )
            return row;
          if (
            row.provider_watch_id &&
            (row.provider_watch_id !== acknowledgment.watchId ||
              canonical(row.provider_ack) !== canonical(acknowledgment))
          )
            throw new ActionRejectedError(
              'Provider changed installation acknowledgment for the same fence',
            );
          return db.exchangeWalletRegistration.update({
            where: { wallet_id: walletId },
            data: {
              provider_watch_id: acknowledgment.watchId,
              provider_ack: acknowledgment as unknown as Prisma.InputJsonValue,
              start_cursor: acknowledgment.startCursor,
              // Missing issuance history cannot be silently replaced by today's chain tip.
              coverage_start_cursor: row.coverage_start_cursor ?? 'origin',
              provider_acknowledged_at: new Date(),
              provider_error: null,
              status: 'backfilling',
            },
          });
        });
        if (
          !this.sameFence(identity, current) ||
          !current.provider_watch_id ||
          current.status !== 'backfilling'
        )
          return current;
      }
      // Bound one recovery tick; unfinished historical pagination remains durably resumable.
      for (let pages = 0; pages < 64 && current.status !== 'ready'; pages++) {
        const expected = current;
        if (
          !expected.provider_watch_id ||
          !expected.start_cursor ||
          !expected.coverage_start_cursor
        )
          throw new Error('Provider coverage is missing its persisted installation fence');
        const identity = this.identity(expected);
        const fromCursor = expected.backfill_cursor ?? expected.coverage_start_cursor;
        const page = providerBackfillPageSchema.parse(
          await this.provider.backfill({
            ...identity,
            watchId: expected.provider_watch_id,
            fromCursor,
            throughCursor: expected.start_cursor,
          }),
        );
        this.match(identity, page);
        if (
          page.watchId !== expected.provider_watch_id ||
          page.fromCursor !== fromCursor ||
          page.throughCursor !== expected.start_cursor ||
          (!page.complete && page.cursor === fromCursor) ||
          (page.complete && page.cursor !== expected.start_cursor)
        )
          throw new ActionRejectedError(
            'Provider backfill response does not match the requested coverage range',
          );
        current = await this.db.$transaction(async (db) => {
          await lock(db, `registry:${walletId}`);
          const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
            where: { wallet_id: walletId },
          });
          if (
            !this.sameFence(expected, row) ||
            ['rebuilding', 'removing', 'removed', 'ready'].includes(row.status) ||
            (row.backfill_cursor ?? row.coverage_start_cursor) !== fromCursor
          )
            return row;
          if (page.complete) {
            const hot = row.hot_wallet_id
              ? await db.exchangeWalletRegistration.findFirst({
                  where: {
                    wallet_id: row.hot_wallet_id,
                    domain_id: row.domain_id,
                    reset_epoch: row.reset_epoch,
                    chain: row.chain,
                    network: row.network,
                    role: 'hot',
                    account: 0,
                    status: 'ready',
                  },
                })
              : null;
            if (!hot) throw new Error('Hot custody registry projection has not committed yet');
            if (row.chain === 'ethereum' || row.chain === 'solana') {
              const management = await db.exchangeWalletRegistration.findFirst({
                where: {
                  domain_id: row.domain_id,
                  reset_epoch: row.reset_epoch,
                  chain: row.chain,
                  network: row.network,
                  role: 'management',
                  account: 1,
                  status: 'ready',
                },
              });
              if (!management)
                throw new Error('Management1 custody registry projection has not committed yet');
            }
          }
          // Every discovery is durable before the same transaction exposes coverage readiness.
          for (const transactionHash of new Set(page.transactionHashes)) {
            const discoveryId = this.uuid(
              `backfill:${row.wallet_id}:${row.provider_generation}:${transactionHash}`,
            );
            const message = {
              type: 'exchange.discovery.received',
              discovery: {
                schemaVersion: 1,
                resetEpoch: row.reset_epoch,
                discoveryId,
                chain: row.chain,
                network: row.network,
                transactionHash,
                walletId: row.wallet_id,
                registryRevision: row.registry_revision,
                source: 'backfill',
              },
            };
            const delivery = await enqueue(
              db,
              QUEUES.activity,
              message as unknown as Message,
              `provider-backfill-${discoveryId}`,
            );
            if (canonical(delivery.payload) !== canonical(message))
              throw new ActionRejectedError(
                'Backfill discovery identity reused with different content',
              );
          }
          const updated = await db.exchangeWalletRegistration.update({
            where: { wallet_id: walletId },
            data: {
              backfill_cursor: page.cursor,
              backfill_complete: page.complete,
              last_backfill_at: new Date(),
              provider_error: null,
              status: page.complete ? 'ready' : 'backfilling',
            },
          });
          if (page.complete) await this.acknowledge(db, updated, 'ready');
          return updated;
        });
        if (
          !this.sameFence(expected, current) ||
          current.status === 'rebuilding' ||
          current.status === 'removed' ||
          current.status === 'removing'
        )
          return current;
      }
      return current;
    } catch (error) {
      const reason =
        error instanceof ActionRejectedError
          ? 'phase3_provider_acknowledgment_or_coverage_mismatch'
          : 'phase3_provider_unavailable_or_invalid_response';
      await this.db.$transaction(async (db) => {
        await lock(db, `registry:${walletId}`);
        const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
          where: { wallet_id: walletId },
        });
        if (!this.sameFence(current, row) || ['ready', 'removed'].includes(row.status)) return;
        const updated = await db.exchangeWalletRegistration.update({
          where: { wallet_id: walletId },
          data: {
            status:
              row.status === 'rebuilding' || row.status === 'removing'
                ? row.status
                : 'awaiting_provider_coverage',
            provider_error: reason,
            backfill_complete: false,
          },
        });
        await this.acknowledge(db, updated, 'rejected', reason);
      });
      throw error;
    }
  }

  async rebuild(walletId: string) {
    await this.db.$transaction(async (db) => {
      await lock(db, `registry:${walletId}`);
      const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: walletId },
      });
      this.checkEpoch(row);
      if (row.role !== 'customer_deposit')
        throw new ActionRejectedError('Custody projections do not install customer watches');
      if (row.status === 'rebuilding') return;
      const updated = await db.exchangeWalletRegistration.update({
        where: { wallet_id: walletId },
        data: {
          status: 'rebuilding',
          coverage_start_cursor:
            row.backfill_cursor ?? row.coverage_start_cursor ?? row.start_cursor,
          backfill_cursor: null,
          backfill_complete: false,
          provider_error: null,
        },
      });
      await this.acknowledge(db, updated, 'rejected', 'phase3_registry_rebuild_requires_backfill');
    });
    return this.recover(walletId);
  }

  async remove(walletId: string) {
    await this.db.$transaction(async (db) => {
      await lock(db, `registry:${walletId}`);
      const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: walletId },
      });
      this.checkEpoch(row);
      if (row.role !== 'customer_deposit')
        throw new ActionRejectedError('Custody projections do not install customer watches');
      if (row.status === 'removed' || row.status === 'removing') return;
      const updated = await db.exchangeWalletRegistration.update({
        where: { wallet_id: walletId },
        data: { status: 'removing', backfill_complete: false },
      });
      await this.acknowledge(db, updated, 'rejected', 'phase3_provider_watch_removed');
    });
    return this.recover(walletId);
  }

  async recoverPending(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new ActionRejectedError('Invalid registry recovery limit');
    await this.cleanUpWatches(limit);
    const readyNetworks = await this.db.exchangeWalletRegistration.findMany({
      where: {
        reset_epoch: this.auth.resetEpoch,
        role: 'customer_deposit',
        status: 'ready',
      },
      distinct: ['chain', 'network'],
      select: { chain: true, network: true },
    });
    const disabled = readyNetworks.filter(
      (row) => !this.provider?.certified(row.chain, row.network),
    );
    const affected = disabled.length
      ? await this.db.exchangeWalletRegistration.findMany({
          where: {
            reset_epoch: this.auth.resetEpoch,
            role: 'customer_deposit',
            status: 'ready',
            OR: disabled,
          },
          take: limit,
          orderBy: { updated_at: 'asc' },
        })
      : [];
    const pendingNetworks = await this.db.exchangeWalletRegistration.findMany({
      where: {
        reset_epoch: this.auth.resetEpoch,
        role: 'customer_deposit',
        status: { notIn: ['ready', 'removed'] },
      },
      distinct: ['chain', 'network'],
      select: { chain: true, network: true },
    });
    const eligible = pendingNetworks.filter((row) =>
      this.provider?.certified(row.chain, row.network),
    );
    // Disabled networks remain durable without consuming an enabled network's retry batch.
    // Query capabilities before applying the limit so old disabled rows cannot starve recovery.
    const rows = eligible.length
      ? await this.db.exchangeWalletRegistration.findMany({
          where: {
            reset_epoch: this.auth.resetEpoch,
            role: 'customer_deposit',
            status: { notIn: ['ready', 'removed'] },
            OR: eligible,
          },
          orderBy: [{ updated_at: 'asc' }, { wallet_id: 'asc' }],
          take: limit,
        })
      : [];
    const results = [];
    for (const row of [...affected, ...rows]) {
      try {
        results.push(await this.recover(row.wallet_id));
      } catch {
        /* Failure is persisted with readiness paused; next tick retries. */
      }
    }
    return results;
  }

  private async finishRemoval(expected: ExchangeWalletRegistration, rebuilding: boolean) {
    if (expected.provider_watch_id) {
      const installed = providerInstallAcknowledgmentSchema.parse(expected.provider_ack);
      const request = { ...this.identity(installed), watchId: expected.provider_watch_id };
      const acknowledgment = providerRemoveAcknowledgmentSchema.parse(
        await this.provider!.remove(request),
      );
      this.match(request, acknowledgment);
      if (acknowledgment.watchId !== request.watchId)
        throw new ActionRejectedError('Provider removed acknowledgment watch mismatch');
    }
    return this.db.$transaction(async (db) => {
      await lock(db, `registry:${expected.wallet_id}`);
      const row = await db.exchangeWalletRegistration.findUniqueOrThrow({
        where: { wallet_id: expected.wallet_id },
      });
      if (!this.sameFence(expected, row) || row.status !== (rebuilding ? 'rebuilding' : 'removing'))
        return row;
      await db.exchangeProviderWatchLease.updateMany({
        where: { generation: expected.provider_generation, state: { not: 'removed' } },
        data: { state: expected.provider_watch_id ? 'removed' : 'cleanup' },
      });
      return db.exchangeWalletRegistration.update({
        where: { wallet_id: expected.wallet_id },
        data: {
          status: rebuilding ? 'awaiting_provider_coverage' : 'removed',
          provider_generation: randomUUID(),
          provider_watch_id: null,
          provider_ack: activityDbNull,
          provider_acknowledged_at: null,
          backfill_cursor: null,
          backfill_complete: false,
          provider_error: null,
        },
      });
    });
  }

  private async cleanUpWatches(limit: number) {
    const provider = this.provider;
    if (!provider) return;
    const pendingNetworks = await this.db.exchangeProviderWatchLease.findMany({
      where: { reset_epoch: this.auth.resetEpoch, state: 'cleanup' },
      distinct: ['provider', 'chain', 'network'],
      select: { provider: true, chain: true, network: true },
    });
    const eligible = pendingNetworks.filter((row) => {
      const selectedProvider = provider.providerFor?.(row.chain, row.network) ?? provider.name;
      return row.provider === selectedProvider && provider.certified(row.chain, row.network);
    });
    if (!eligible.length) return;
    const leases = await this.db.exchangeProviderWatchLease.findMany({
      where: { reset_epoch: this.auth.resetEpoch, state: 'cleanup', OR: eligible },
      orderBy: [{ updated_at: 'asc' }, { generation: 'asc' }],
      take: limit,
    });
    for (const lease of leases) {
      try {
        const request = lease.install_request as unknown as ProviderInstallRequest;
        const installed = lease.acknowledgment
          ? providerInstallAcknowledgmentSchema.parse(lease.acknowledgment)
          : providerInstallAcknowledgmentSchema.parse(await provider.install(request));
        this.match(request, installed);
        // Recover even an install that succeeded remotely but lost its acknowledgment.
        await this.db.exchangeProviderWatchLease.update({
          where: { generation: lease.generation },
          data: {
            watch_id: installed.watchId,
            acknowledgment: installed as unknown as Prisma.InputJsonValue,
          },
        });
        const removed = providerRemoveAcknowledgmentSchema.parse(
          await provider.remove({
            ...this.identity(installed),
            watchId: installed.watchId,
          }),
        );
        this.match(installed, removed);
        if (removed.watchId !== installed.watchId)
          throw new ActionRejectedError('Provider cleanup acknowledgment watch mismatch');
        await this.db.exchangeProviderWatchLease.update({
          where: { generation: lease.generation },
          data: { state: 'removed', last_error: null },
        });
      } catch {
        await this.db.exchangeProviderWatchLease.update({
          where: { generation: lease.generation },
          data: { last_error: 'phase3_provider_cleanup_pending' },
        });
      }
    }
  }

  private async acknowledge(
    db: Transaction,
    row: ExchangeWalletRegistration,
    status: 'ready' | 'rejected',
    reason?: string,
  ) {
    const request = row.request as unknown as RegistryRequest;
    const revision = row.readiness_revision + 1;
    const event = exchangeEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: 1,
      resetEpoch: row.reset_epoch,
      occurredAt: new Date().toISOString(),
      domainId: row.domain_id,
      correlationId: request.correlationId,
      causationId: request.eventId,
      aggregateId: request.aggregateId,
      revision,
      ...(row.customer_id ? { customerId: row.customer_id } : {}),
      type: 'customer-wallet.registry.acknowledged.v1',
      data: {
        walletId: row.wallet_id,
        consumer: 'activity-listener',
        registryRevision: row.registry_revision,
        status,
        coverageComplete: status === 'ready',
        ...(reason ? { reason } : {}),
        ...(status === 'ready'
          ? { startCursor: row.start_cursor!, backfillCursor: row.backfill_cursor! }
          : {}),
      },
    });
    await enqueueFanOut(db, event, [QUEUES.wallet]);
    await db.exchangeWalletRegistration.update({
      where: { wallet_id: row.wallet_id },
      data: { readiness_revision: revision },
    });
  }

  private identity(row: ExchangeWalletRegistration | ProviderWatchIdentity): ProviderWatchIdentity {
    if ('protocolVersion' in row)
      return {
        protocolVersion: 1,
        provider: row.provider,
        domainId: row.domainId,
        resetEpoch: row.resetEpoch,
        walletId: row.walletId,
        registryRevision: row.registryRevision,
        generation: row.generation,
        chain: row.chain,
        network: row.network,
        address: row.address,
        assetScope: 'native',
      };
    return {
      protocolVersion: 1,
      provider: this.provider!.providerFor?.(row.chain, row.network) ?? this.provider!.name,
      domainId: row.domain_id,
      resetEpoch: row.reset_epoch,
      walletId: row.wallet_id,
      registryRevision: row.registry_revision,
      generation: row.provider_generation,
      chain: row.chain as ProviderWatchIdentity['chain'],
      network: row.network,
      address: row.address,
      assetScope: 'native',
    };
  }

  private sameFence(
    expected: ExchangeWalletRegistration | ProviderWatchIdentity,
    actual: ExchangeWalletRegistration,
  ) {
    const generation =
      'generation' in expected ? expected.generation : expected.provider_generation;
    const revision =
      'registryRevision' in expected ? expected.registryRevision : expected.registry_revision;
    return (
      generation === actual.provider_generation &&
      revision === actual.registry_revision &&
      actual.reset_epoch === this.auth.resetEpoch
    );
  }

  private match(expected: ProviderWatchIdentity, actual: ProviderWatchIdentity) {
    if (canonical(this.identity(expected)) !== canonical(this.identity(actual)))
      throw new ActionRejectedError('Provider acknowledgment identity mismatch');
  }

  private checkEpoch(row: ExchangeWalletRegistration) {
    if (row.reset_epoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale registry epoch');
  }

  private async row(walletId: string) {
    const row = await this.db.exchangeWalletRegistration.findUniqueOrThrow({
      where: { wallet_id: walletId },
    });
    this.checkEpoch(row);
    return row;
  }

  private uuid(key: string) {
    const hex = createHash('sha256').update(key).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}
