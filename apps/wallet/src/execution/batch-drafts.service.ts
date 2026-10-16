import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import { MessageAuth } from '../../../../packages/queue/src/messages.js';
import { lock } from '../../../../packages/database/src/locks.js';
import {
  payoutBatchManifestSchema,
  payoutBatchDigest,
  PayoutBatchManifest,
} from '../../../../packages/shared/src/payout-policy.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  tokenCertificateSchema,
  tokenAsset,
} from '../../../../packages/shared/src/token-contracts.js';
import { executionDigest } from '../../../../packages/shared/src/execution-authorization.js';
import { BitcoinBatchPlanner } from '../../../../packages/chain/src/bitcoin-batch-planner.js';

/** Durable planning only: no signer/broadcast outbox publication and no customer-hold release. */
@Injectable()
export class BatchDraftsService {
  constructor(
    private readonly db: WalletPrismaService,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
    private readonly auth: MessageAuth,
    private readonly bitcoin?: BitcoinBatchPlanner,
  ) {}

  async prepareBitcoin(batchId: string) {
    if (!this.bitcoin) throw new ActionRejectedError('Bitcoin batch planner is unavailable');
    const snapshot = await this.db.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
    });
    if (
      snapshot.domain_id !== this.config.domainId ||
      snapshot.reset_epoch !== this.auth.resetEpoch
    )
      throw new ActionRejectedError('Batch preparation custody scope mismatch');
    return this.db.$transaction(
      async (tx) => {
        await lock(tx, `custody-source:${snapshot.source_wallet_id}`);
        const batch = await tx.withdrawalBatchDraft.findUniqueOrThrow({ where: { id: batchId } });
        if (batch.state !== 'planned')
          throw new ActionRejectedError('Unsigned batch is already released');
        const existing = await tx.withdrawalBatchPreparation.findUnique({
          where: { batch_id: batchId },
        });
        if (existing) {
          if (existing.expires_at <= new Date())
            throw new ActionRejectedError(
              'Expired unsigned preparation requires complete draft dissolution',
            );
          return existing;
        }
        const manifest = payoutBatchManifestSchema.parse(batch.manifest);
        if (manifest.seedId !== this.config.seedId)
          throw new ActionRejectedError(
            'Batch preparation seed differs from the configured custody seed',
          );
        const domain = await tx.custodyDomain.findUniqueOrThrow({ where: { id: batch.domain_id } });
        const source = await tx.wallet.findUniqueOrThrow({ where: { id: batch.source_wallet_id } });
        const registry = await tx.exchangeWalletRegistry.findUnique({
          where: { wallet_id: source.id },
        });
        const asset = await tx.assetConfiguration.findUniqueOrThrow({
          where: {
            domain_id_chain_network_asset_id: {
              domain_id: batch.domain_id,
              chain: manifest.asset.chain,
              network: manifest.asset.network,
              asset_id: manifest.asset.assetId,
            },
          },
        });
        if (
          domain.status !== 'active' ||
          domain.reset_epoch !== manifest.resetEpoch ||
          domain.seed_id !== manifest.seedId ||
          !source.active ||
          source.status !== 'ready' ||
          !source.published_at ||
          source.registry_revision !== manifest.sourceRegistryRevision ||
          registry?.ledger_status !== 'ready' ||
          registry.ledger_ack_revision !== source.registry_revision ||
          !asset.withdrawal_enabled
        )
          throw new ActionRejectedError('Batch preparation admission changed');
        for (const member of manifest.members) {
          const customer = await tx.exchangeCustomer.findUniqueOrThrow({
            where: { customer_id: member.customerId },
          });
          if (
            customer.state !== 'active' ||
            customer.ledger_status !== 'ready' ||
            BigInt(member.maximumFeeUnits) > BigInt(asset.maximum_fee_units)
          )
            throw new ActionRejectedError('Batch member admission changed');
        }
        const preparation = await this.bitcoin!.plan(manifest);
        const row = await tx.withdrawalBatchPreparation.create({
          data: {
            batch_id: batchId,
            preparation: preparation as unknown as Prisma.InputJsonValue,
            preparation_digest: preparation.preparationDigest,
            expires_at: new Date(preparation.expiresAt),
          },
        });
        for (const resource of [...preparation.resourceKeys].sort()) {
          const key = `${manifest.domainId}:${manifest.resetEpoch}:bitcoin:regtest:${resource}`;
          await lock(tx, `execution-resource:${key}`);
          await tx.withdrawalBatchResource.create({
            data: { batch_id: batchId, resource_key: key },
          });
        }
        return row;
      },
      { timeout: 30_000 },
    );
  }

  async claim(input: PayoutBatchManifest) {
    const manifest = payoutBatchManifestSchema.parse(input),
      digest = payoutBatchDigest(manifest);
    if (
      manifest.domainId !== this.config.domainId ||
      manifest.resetEpoch !== this.auth.resetEpoch ||
      manifest.seedId !== this.config.seedId
    )
      throw new ActionRejectedError('Batch draft custody scope mismatch');
    return this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${manifest.sourceWalletId}`);
      const existing = await tx.withdrawalBatchDraft.findUnique({
        where: { id: manifest.batchId },
      });
      if (existing) {
        if (existing.manifest_digest !== digest)
          throw new ActionRejectedError('Batch draft identity is immutable');
        return existing;
      }
      const domain = await tx.custodyDomain.findUniqueOrThrow({ where: { id: manifest.domainId } });
      if (
        domain.status !== 'active' ||
        domain.reset_epoch !== manifest.resetEpoch ||
        domain.seed_id !== manifest.seedId
      )
        throw new ActionRejectedError('Batch draft custody domain is paused or changed');
      const source = await tx.wallet.findUniqueOrThrow({ where: { id: manifest.sourceWalletId } });
      const registry = await tx.exchangeWalletRegistry.findUnique({
        where: { wallet_id: source.id },
      });
      if (
        source.custody_domain_id !== manifest.domainId ||
        source.reset_epoch !== manifest.resetEpoch ||
        source.seed_id !== manifest.seedId ||
        source.chain !== manifest.asset.chain ||
        source.network !== manifest.asset.network ||
        source.custody_role !== 'hot' ||
        source.account !== 0 ||
        source.status !== 'ready' ||
        !source.active ||
        !source.published_at ||
        source.address !== manifest.sourceAddress ||
        source.registry_revision !== manifest.sourceRegistryRevision ||
        registry?.ledger_status !== 'ready' ||
        registry.ledger_ack_revision !== source.registry_revision ||
        registry.registry_revision !== source.registry_revision
      )
        throw new ActionRejectedError(
          'Batch draft requires its published Ledger-acknowledged hot source',
        );
      const asset = await tx.assetConfiguration.findUniqueOrThrow({
        where: {
          domain_id_chain_network_asset_id: {
            domain_id: manifest.domainId,
            chain: manifest.asset.chain,
            network: manifest.asset.network,
            asset_id: manifest.asset.assetId,
          },
        },
      });
      if (
        !asset.withdrawal_enabled ||
        manifest.members.some(
          (m) =>
            BigInt(m.maximumFeeUnits) > BigInt(asset.maximum_fee_units) ||
            BigInt(m.maximumRentUnits) > 10_000_000n,
        )
      )
        throw new ActionRejectedError('Batch draft exceeds asset admission budgets');
      if (!manifest.asset.assetId.endsWith(':native')) {
        const certificate = tokenCertificateSchema.safeParse(asset.transfer_certificate);
        if (
          !certificate.success ||
          executionDigest(tokenAsset(certificate.data)) !== executionDigest(manifest.asset)
        )
          throw new ActionRejectedError(
            'Token batch draft requires the exact certified transfer-only asset',
          );
      }
      const draft = await tx.withdrawalBatchDraft.create({
        data: {
          id: manifest.batchId,
          source_wallet_id: source.id,
          domain_id: manifest.domainId,
          reset_epoch: manifest.resetEpoch,
          manifest: manifest as Prisma.InputJsonValue,
          manifest_digest: digest,
        },
      });
      for (const [index, member] of manifest.members.entries()) {
        await lock(tx, `withdrawal:${member.operationId}`);
        const w = await tx.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
        const customer = await tx.exchangeCustomer.findUnique({
          where: { customer_id: w.customer_id },
        });
        if (
          customer?.state !== 'active' ||
          customer.ledger_status !== 'ready' ||
          customer.domain_id !== manifest.domainId ||
          customer.reset_epoch !== manifest.resetEpoch ||
          w.state !== 'queued' ||
          w.cancel_requested ||
          w.attempt_id ||
          w.batch_draft_id ||
          w.reservation_id !== member.reservationId ||
          w.customer_id !== member.customerId ||
          w.request_digest !== member.requestDigest ||
          w.domain_id !== manifest.domainId ||
          w.reset_epoch !== manifest.resetEpoch ||
          w.hot_wallet_id !== source.id ||
          w.hot_registry_revision !== source.registry_revision ||
          w.chain !== manifest.asset.chain ||
          w.network !== manifest.asset.network ||
          w.asset_id !== manifest.asset.assetId ||
          w.principal_units !== member.principalUnits ||
          w.destination !== member.destination ||
          (await tx.custodyExecution.findUnique({ where: { operation_id: w.id } }))
        )
          throw new ActionRejectedError(
            'Batch member differs from its untouched original held withdrawal',
          );
        await tx.withdrawal.update({
          where: { id: w.id },
          data: {
            batch_draft_id: draft.id,
            attempt_id: member.attemptId,
            state: 'batch_planned',
            revision: { increment: 1 },
          },
        });
        await tx.withdrawalBatchDraftMember.create({
          data: {
            batch_id: draft.id,
            member_index: index,
            withdrawal_id: w.id,
            attempt_id: member.attemptId,
            reservation_id: member.reservationId,
          },
        });
      }
      return draft;
    });
  }

  async releaseUnsigned(batchId: string) {
    const snapshot = await this.db.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
    });
    if (
      snapshot.domain_id !== this.config.domainId ||
      snapshot.reset_epoch !== this.auth.resetEpoch
    )
      throw new ActionRejectedError('Batch draft custody scope mismatch');
    return this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${snapshot.source_wallet_id}`);
      return this.releaseWithin(tx, batchId);
    });
  }

  async releaseWithin(tx: Prisma.TransactionClient, batchId: string) {
    const batch = await tx.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
      include: { members: true },
    });
    if (batch.domain_id !== this.config.domainId || batch.reset_epoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Batch dissolution scope mismatch');
    if (await tx.bitcoinBatchExecution.findUnique({ where: { batch_id: batchId } }))
      throw new ActionRejectedError('Admitted batch cannot use unsigned dissolution');
    if (batch.state === 'released') return batch;
    // Drafts have no signing/broadcast states; a later protocol must not reuse this release path for signed batches.
    if (batch.state !== 'planned')
      throw new ActionRejectedError('Only an unsigned draft may dissolve');
    await tx.withdrawalBatchDraft.update({
      where: { id: batch.id },
      data: { state: 'released', released_at: new Date() },
    });
    for (const member of batch.members) {
      await lock(tx, `withdrawal:${member.withdrawal_id}`);
      await tx.withdrawalBatchDraftMember.update({
        where: {
          batch_id_member_index: { batch_id: batch.id, member_index: member.member_index },
        },
        data: { active: false },
      });
      await tx.withdrawal.update({
        where: { id: member.withdrawal_id },
        data: {
          batch_draft_id: null,
          attempt_id: null,
          state: 'queued',
          revision: { increment: 1 },
        },
      });
    }
    return tx.withdrawalBatchDraft.findUniqueOrThrow({ where: { id: batch.id } });
  }
}
