import { Inject, Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ExchangeTokenWatch } from '.prisma/activity-client';
import { ActivityPrismaService } from '../prisma/prisma.service.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { SweepDeferral } from '../../../../packages/chain/src/native-sweep-planner.js';
import { TokenCertificate } from '../../../../packages/shared/src/token-contracts.js';
import { TokenPlanner } from '../../../../packages/chain/src/token-planner.js';
import { associatedTokenAddress } from '../../../../packages/chain/src/token-encoding.js';
import {
  tokenAsset,
  tokenCertificateSchema,
} from '../../../../packages/shared/src/token-contracts.js';
import { executionDigest } from '../../../../packages/shared/src/execution-authorization.js';
import {
  ExchangeEvent,
  exchangeEventSchema,
} from '../../../../packages/queue/src/exchange-contracts.js';
import { MessageAuth, QUEUES, canonical } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { exchangeDiscoverySchema } from '../../../../packages/shared/src/exchange-discovery.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  ExchangeWatchProvider,
  EXCHANGE_WATCH_PROVIDER,
  ProviderWatchIdentity,
  providerWatchIdentitySchema,
} from '../provider/provider.contracts.js';

type Registration = Extract<ExchangeEvent, { type: 'asset.transfer.registry.requested.v1' }>;
/** Token watches have independent generations/cursors; native readiness never certifies token history. */
@Injectable()
export class TokenRegistryService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: ActivityPrismaService,
    private readonly rpc: ChainRpcService,
    private readonly auth: MessageAuth,
    @Optional() @Inject(EXCHANGE_WATCH_PROVIDER) private readonly provider?: ExchangeWatchProvider,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.recover()
          .catch(() => undefined)
          .finally(() => {
            this.running = undefined;
          });
    }, 30000);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async register(event: Registration) {
    if (event.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Stale token certification epoch');
    const c = tokenCertificateSchema.parse(event.data.certificate),
      asset = tokenAsset(c);
    if (event.data.creditEnabled && !event.data.observationEnabled)
      throw new ActionRejectedError('Token credit requires observation');
    if (event.data.observationEnabled) await new TokenPlanner(this.rpc).validateCertificate(c);
    await this.db.$transaction(async (tx) => {
      await lock(tx, `token-registry:${event.domainId}:${event.resetEpoch}:${asset.assetId}`);
      const key = {
        domain_id: event.domainId,
        reset_epoch: event.resetEpoch,
        ...{ chain: asset.chain, network: asset.network, asset_id: asset.assetId },
      };
      const existing = await tx.exchangeTokenAsset.findUnique({
        where: { domain_id_reset_epoch_chain_network_asset_id: key },
      });
      if (existing) {
        if (existing.certificate_digest !== executionDigest(c))
          throw new ActionRejectedError('Token transfer certificate is immutable');
        if (existing.configuration_revision > event.data.configurationRevision) return;
        if (
          existing.configuration_revision === event.data.configurationRevision &&
          canonical((existing.request as unknown as Registration).data) !== canonical(event.data)
        )
          throw new ActionRejectedError('Token revision conflicts with recorded flags');
      }
      await tx.exchangeTokenAsset.upsert({
        where: { domain_id_reset_epoch_chain_network_asset_id: key },
        create: {
          ...key,
          certificate: c,
          certificate_digest: executionDigest(c),
          configuration_revision: event.data.configurationRevision,
          observation_enabled: event.data.observationEnabled,
          credit_enabled: event.data.creditEnabled,
          request: event as Prisma.InputJsonValue,
        },
        update: {
          configuration_revision: event.data.configurationRevision,
          observation_enabled: event.data.observationEnabled,
          credit_enabled: event.data.creditEnabled,
          request: event as Prisma.InputJsonValue,
        },
      });
    });
    await this.recover();
  }

  async validateIncoming(certificate: TokenCertificate, owner: string, tokenAccount?: string) {
    try {
      const planner = new TokenPlanner(this.rpc);
      await planner.validateCertificate(certificate);
      if (certificate.standard === 'erc20') return true;
      const accounts = await planner.discoverOwnedAccounts(certificate, owner);
      return accounts.some(
        (a) => a.address === tokenAccount && a.owner === owner && a.state === 'spendable',
      );
    } catch (error) {
      if (error instanceof SweepDeferral && error.code === 'attention') return false;
      throw error;
    }
  }

  async recover() {
    const assets = await this.db.exchangeTokenAsset.findMany({
      where: { reset_epoch: this.auth.resetEpoch },
    });
    for (const asset of assets) {
      const c = tokenCertificateSchema.parse(asset.certificate);
      const wallets = await this.db.exchangeWalletRegistration.findMany({
        where: {
          domain_id: asset.domain_id,
          reset_epoch: asset.reset_epoch,
          chain: c.chain,
          network: c.network,
          role: 'customer_deposit',
        },
      });
      for (const wallet of wallets) {
        let ticket: ExchangeTokenWatch | undefined;
        try {
          const current = await this.db.exchangeTokenWatch.findUnique({
            where: {
              wallet_id_asset_id: { wallet_id: wallet.wallet_id, asset_id: asset.asset_id },
            },
          });
          ticket = current ?? undefined;
          if (
            !asset.observation_enabled ||
            wallet.status !== 'ready' ||
            !wallet.backfill_complete
          ) {
            if (current && current.state !== 'paused') await this.remove(current);
            continue;
          }
          if (!this.provider?.tokenCertified?.(c.chain, c.network)) continue;
          if (current?.lease_until && current.lease_until > new Date()) continue;
          if (
            current?.next_check_at &&
            current.next_check_at > new Date() &&
            current.configuration_revision === asset.configuration_revision &&
            current.state !== 'paused'
          )
            continue;
          await new TokenPlanner(this.rpc).validateCertificate(c);
          const owned =
            c.standard === 'spl'
              ? await new TokenPlanner(this.rpc).discoverOwnedAccounts(c, wallet.address)
              : [];
          const addresses =
            c.standard === 'spl'
              ? [
                  ...new Set([
                    await associatedTokenAddress(wallet.address, c.mint),
                    ...owned.map((a) => a.address),
                  ]),
                ].sort()
              : [];
          if (addresses.length > 100)
            throw new ActionRejectedError('Owned token account watch limit exceeded');
          const identity: ProviderWatchIdentity = {
            protocolVersion: 1,
            provider: this.provider.providerFor?.(c.chain, c.network) ?? this.provider.name,
            domainId: wallet.domain_id,
            resetEpoch: wallet.reset_epoch,
            walletId: wallet.wallet_id,
            registryRevision: wallet.registry_revision,
            generation: current?.generation ?? randomUUID(),
            chain: c.chain,
            network: c.network,
            address: wallet.address,
            assetScope: 'native-and-transfer-tokens',
            tokenAssets: [c],
            ...(c.standard === 'spl'
              ? {
                  tokenAccounts: addresses.map((address) => ({
                    address,
                    owner: wallet.address,
                    mint: c.mint,
                    programId: c.programId,
                  })),
                }
              : {}),
          };
          const prior = current ? providerWatchIdentitySchema.parse(current.identity) : undefined;
          if (
            current &&
            (current.configuration_revision !== asset.configuration_revision ||
              current.registry_revision !== wallet.registry_revision ||
              canonical({ ...prior, generation: null }) !==
                canonical({ ...identity, generation: null }) ||
              current.state === 'paused')
          ) {
            if (current.state !== 'paused') await this.remove(current);
            identity.generation = randomUUID();
          }
          let row = await this.db.$transaction(async (tx) => {
            await lock(tx, `token-watch:${wallet.wallet_id}:${asset.asset_id}`);
            const latest = await tx.exchangeTokenWatch.findUnique({
              where: {
                wallet_id_asset_id: { wallet_id: wallet.wallet_id, asset_id: asset.asset_id },
              },
            });
            if (latest?.lease_until && latest.lease_until > new Date()) return null;
            if (latest && current && latest.generation !== current.generation) return null;
            const changed = !latest || latest.generation !== identity.generation;
            const next = await tx.exchangeTokenWatch.upsert({
              where: {
                wallet_id_asset_id: { wallet_id: wallet.wallet_id, asset_id: asset.asset_id },
              },
              create: {
                id: randomUUID(),
                wallet_id: wallet.wallet_id,
                domain_id: wallet.domain_id,
                reset_epoch: wallet.reset_epoch,
                asset_id: asset.asset_id,
                configuration_revision: asset.configuration_revision,
                registry_revision: wallet.registry_revision,
                generation: identity.generation,
                identity,
                state: 'installing',
                start_cursor: wallet.coverage_start_cursor ?? wallet.start_cursor,
                lease_until: new Date(Date.now() + 120000),
                revision: 1,
              },
              update: {
                ...(changed
                  ? {
                      generation: identity.generation,
                      identity,
                      configuration_revision: asset.configuration_revision,
                      registry_revision: wallet.registry_revision,
                      state: 'installing',
                      watch_id: null,
                      start_cursor: wallet.coverage_start_cursor ?? wallet.start_cursor,
                      through_cursor: null,
                      cursor: null,
                    }
                  : {}),
                lease_until: new Date(Date.now() + 120000),
                revision: { increment: 1 },
              },
            });
            if (changed) await this.ack(tx, next, false);
            return next;
          });
          if (!row) continue;
          ticket = row;
          if (row.state === 'ready') {
            await this.release(row, { next_check_at: new Date(Date.now() + 30000) });
            continue;
          }
          if (!row.watch_id) {
            const ack = await this.provider.install({
              ...identity,
              ...(row.start_cursor ? { fromCursor: row.start_cursor } : {}),
            });
            this.match(identity, ack);
            row = await this.release(row, {
              watch_id: ack.watchId,
              through_cursor: ack.startCursor,
              start_cursor: row.start_cursor ?? ack.startCursor,
              cursor: row.start_cursor ?? ack.startCursor,
              state: 'backfill',
            });
            ticket = row;
          }
          const page = await this.provider.backfill({
            ...identity,
            watchId: row.watch_id!,
            fromCursor: row.cursor!,
            throughCursor: row.through_cursor!,
          });
          this.match(identity, page);
          if (
            page.watchId !== row.watch_id ||
            page.fromCursor !== row.cursor ||
            page.throughCursor !== row.through_cursor ||
            (!page.complete && page.cursor === row.cursor) ||
            (page.complete && page.cursor !== row.through_cursor)
          )
            throw new ActionRejectedError('Token backfill identity/cursor mismatch');
          await this.db.$transaction(async (tx) => {
            await lock(tx, `token-watch:${wallet.wallet_id}:${asset.asset_id}`);
            const fresh = await tx.exchangeTokenWatch.findUniqueOrThrow({ where: { id: row!.id } });
            if (fresh.generation !== row!.generation || fresh.revision !== row!.revision) return;
            for (const hash of page.transactionHashes) {
              const discovery = exchangeDiscoverySchema.parse({
                schemaVersion: 1,
                resetEpoch: identity.resetEpoch,
                discoveryId: `token-backfill:${identity.generation}:${hash}`,
                source: 'backfill',
                chain: identity.chain,
                network: identity.network,
                transactionHash: hash,
                walletId: identity.walletId,
                registryRevision: identity.registryRevision,
              });
              await enqueue(
                tx,
                QUEUES.activity,
                { type: 'exchange.discovery.received', discovery },
                `token-backfill:${identity.generation}:${hash}`,
              );
            }
            const updated = await tx.exchangeTokenWatch.update({
              where: { id: fresh.id },
              data: {
                state: page.complete ? 'ready' : 'backfill',
                cursor: page.cursor,
                lease_until: null,
                next_check_at: new Date(Date.now() + (page.complete ? 30000 : 0)),
                last_error: null,
                revision: { increment: 1 },
              },
            });
            if (page.complete) await this.ack(tx, updated, true);
          });
        } catch (error) {
          if (ticket)
            await this.db.exchangeTokenWatch.updateMany({
              where: { id: ticket.id, generation: ticket.generation, revision: ticket.revision },
              data: {
                lease_until: null,
                last_error:
                  error instanceof ActionRejectedError
                    ? error.message
                    : 'Token watch recovery unavailable',
                next_check_at: new Date(Date.now() + 30000),
              },
            });
        }
      }
    }
  }

  private match(identity: ProviderWatchIdentity, actual: ProviderWatchIdentity) {
    if (canonical(providerWatchIdentitySchema.strip().parse(actual)) !== canonical(identity))
      throw new ActionRejectedError('Token provider watch identity mismatch');
  }

  private async release(row: ExchangeTokenWatch, data: Prisma.ExchangeTokenWatchUpdateInput) {
    return this.db.$transaction(async (tx) => {
      await lock(tx, `token-watch:${row.wallet_id}:${row.asset_id}`);
      const fresh = await tx.exchangeTokenWatch.findUniqueOrThrow({ where: { id: row.id } });
      if (fresh.generation !== row.generation || fresh.revision !== row.revision)
        throw new ActionRejectedError('Token watch generation superseded');
      return tx.exchangeTokenWatch.update({
        where: { id: row.id },
        data: { ...data, lease_until: null, revision: { increment: 1 } },
      });
    });
  }

  private async remove(row: ExchangeTokenWatch) {
    if (this.provider && row.state !== 'paused') {
      const identity = providerWatchIdentitySchema.parse(row.identity);
      let watchId = row.watch_id;
      if (!watchId) {
        const installation = await this.provider.install({
          ...identity,
          ...(row.start_cursor ? { fromCursor: row.start_cursor } : {}),
        });
        this.match(identity, installation);
        watchId = installation.watchId;
      }
      const ack = await this.provider.remove({ ...identity, watchId });
      this.match(identity, ack);
      if (ack.watchId !== watchId) throw new ActionRejectedError('Token removal identity mismatch');
    }
    await this.db.$transaction(async (tx) => {
      await lock(tx, `token-watch:${row.wallet_id}:${row.asset_id}`);
      const current = await tx.exchangeTokenWatch.findUniqueOrThrow({ where: { id: row.id } });
      if (current.generation !== row.generation || current.revision !== row.revision) return;
      const updated = await tx.exchangeTokenWatch.update({
        where: { id: row.id },
        data: { state: 'paused', lease_until: null, revision: { increment: 1 } },
      });
      await this.ack(tx, updated, false);
    });
  }

  private async ack(tx: Prisma.TransactionClient, row: ExchangeTokenWatch, ready: boolean) {
    const identity = providerWatchIdentitySchema.parse(row.identity),
      c = identity.tokenAssets![0];
    await enqueue(
      tx,
      QUEUES.wallet,
      exchangeEventSchema.parse({
        eventId: randomUUID(),
        schemaVersion: 1,
        resetEpoch: row.reset_epoch,
        occurredAt: new Date().toISOString(),
        domainId: row.domain_id,
        correlationId: randomUUID(),
        causationId: null,
        aggregateId: row.id,
        revision: row.revision,
        type: 'asset.transfer.watch.acknowledged.v1',
        data: {
          walletId: row.wallet_id,
          asset: tokenAsset(c),
          certificateDigest: executionDigest(c),
          configurationRevision: row.configuration_revision,
          registryRevision: row.registry_revision,
          generation: row.generation,
          ready,
          ...(ready ? { cursor: row.cursor! } : {}),
        },
      }),
      `token-watch-ack:${row.id}:${row.revision}`,
    );
  }
}
