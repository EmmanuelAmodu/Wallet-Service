import { Inject, Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { BitcoinBatchExecution, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import { executionConfig, ExecutionSettings } from '../config/execution.config.js';
import { CustodyService } from '../custody/custody.service.js';
import { BatchDraftsService } from './batch-drafts.service.js';
import {
  Message,
  MessageAuth,
  QUEUES,
  broadcastSnapshotSchema,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import {
  NativeSweepPlanner,
  bitcoinDecimalUnits,
  verifyBitcoinPayment,
} from '../../../../packages/chain/src/native-sweep-planner.js';
import {
  validateBitcoinBatch,
  signBitcoinBatchAuthorization,
  bitcoinBatchSignSchema,
  bitcoinBatchAttestedResult,
  PayoutBatchLedgerCommand,
} from '../../../../packages/shared/src/bitcoin-batch-contracts.js';
import { payoutBatchManifestSchema } from '../../../../packages/shared/src/payout-policy.js';
import {
  executionDigest,
  verifySignerAttestation,
} from '../../../../packages/shared/src/execution-authorization.js';
import { signedSchema } from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  rolloutConfig,
  RolloutSettings,
  closedRollout,
  assertRollout,
} from '../../../../packages/shared/src/rollout.config.js';
import { z } from 'zod';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const inclusionSchema = z.object({
  blockHash: z.string().regex(/^[a-f0-9]{64}$/),
  blockHeight: z.string().regex(/^(0|[1-9][0-9]*)$/),
  actualFeeUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
});

/** Wallet owns aggregate orchestration; Ledger owns original holds and atomic financial journals. */
@Injectable()
export class BitcoinBatchExecutionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: WalletPrismaService,
    private readonly auth: MessageAuth,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
    @Inject(executionConfig.KEY) private readonly settings: ExecutionSettings,
    private readonly custody: CustodyService,
    private readonly drafts: BatchDraftsService,
    private readonly rpc: ChainRpcService,
    @Optional()
    @Inject(rolloutConfig.KEY)
    private readonly rollout: RolloutSettings = closedRollout,
  ) {}

  onModuleInit() {
    if (!this.settings.bitcoinBatchesEnabled) return;
    const tick = () => {
      if (!this.running)
        this.running = this.repairDue()
          .catch(() => undefined)
          .finally(() => {
            this.running = undefined;
          });
    };
    this.timer = setInterval(tick, this.settings.pollIntervalMs);
    tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private enabled() {
    if (
      !this.settings.enabled ||
      !this.settings.withdrawalsEnabled ||
      !this.settings.bitcoinBatchesEnabled ||
      !this.settings.authorityPrivateKey ||
      !this.settings.signerPublicKey
    )
      throw new ActionRejectedError('Bitcoin batch execution is disabled');
  }

  private async context(tx: Prisma.TransactionClient, batchId: string) {
    const draft = await tx.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
      include: { preparation: true },
    });
    if (
      draft.domain_id !== this.config.domainId ||
      draft.reset_epoch !== this.auth.resetEpoch ||
      !draft.preparation
    )
      throw new ActionRejectedError('Batch execution custody scope mismatch');
    const validated = validateBitcoinBatch(draft.manifest, draft.preparation.preparation);
    if (validated.manifest.seedId !== this.config.seedId)
      throw new ActionRejectedError('Batch execution seed mismatch');
    return { ...validated, draft };
  }

  private async admission(tx: Prisma.TransactionClient, batchId: string) {
    this.enabled();
    const context = await this.context(tx, batchId),
      { manifest } = context;
    try {
      assertRollout(this.rollout, 'withdrawals', {
        domainId: manifest.domainId,
        chain: 'bitcoin',
        network: 'regtest',
      });
    } catch {
      throw new ActionRejectedError('Bitcoin batch rollout is closed');
    }
    await tx.$executeRaw`LOCK TABLE wallets IN SHARE MODE`;
    await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${manifest.domainId} FOR UPDATE`;
    const source = await tx.wallet.findUniqueOrThrow({ where: { id: manifest.sourceWalletId } });
    const registry = await tx.exchangeWalletRegistry.findUnique({
      where: { wallet_id: source.id },
    });
    const asset = await tx.assetConfiguration.findUniqueOrThrow({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: manifest.domainId,
          chain: 'bitcoin',
          network: 'regtest',
          asset_id: 'token:bitcoin:native',
        },
      },
    });
    if (
      !(await this.custody.publicationAllowed(tx, source)) ||
      source.status !== 'ready' ||
      !source.published_at ||
      source.customer_id !== null ||
      source.address !== manifest.sourceAddress ||
      source.custody_role !== 'hot' ||
      source.account !== 0 ||
      source.registry_revision !== manifest.sourceRegistryRevision ||
      registry?.ledger_status !== 'ready' ||
      registry.ledger_ack_revision !== source.registry_revision ||
      registry.registry_revision !== source.registry_revision ||
      registry.address !== source.address ||
      registry.domain_id !== manifest.domainId ||
      registry.reset_epoch !== manifest.resetEpoch ||
      !asset.withdrawal_enabled
    )
      throw new ActionRejectedError('Batch hot source or asset admission changed');
    for (const member of manifest.members) {
      await tx.$queryRaw`SELECT customer_id FROM exchange_customers WHERE customer_id=${member.customerId}::uuid FOR UPDATE`;
      await lock(tx, `withdrawal:${member.operationId}`);
      const customer = await tx.exchangeCustomer.findUniqueOrThrow({
        where: { customer_id: member.customerId },
      });
      const w = await tx.withdrawal.findUniqueOrThrow({ where: { id: member.operationId } });
      if (
        customer.state !== 'active' ||
        customer.ledger_status !== 'ready' ||
        customer.domain_id !== manifest.domainId ||
        customer.reset_epoch !== manifest.resetEpoch ||
        w.batch_draft_id !== batchId ||
        w.attempt_id !== member.attemptId ||
        w.reservation_id !== member.reservationId ||
        w.cancel_requested ||
        w.policy_version !== asset.policy_version ||
        BigInt(member.maximumFeeUnits) > BigInt(asset.maximum_fee_units) ||
        (await tx.wallet.findFirst({
          where: { chain: 'bitcoin', network: 'regtest', address: member.destination },
        })) ||
        (await tx.exchangeWalletRegistry.findFirst({
          where: { chain: 'bitcoin', network: 'regtest', address: member.destination },
        }))
      )
        throw new ActionRejectedError('Batch member admission changed');
    }
    return { ...context, source };
  }

  private async revalidate(context: Awaited<ReturnType<BitcoinBatchExecutionService['context']>>) {
    const { preparation } = context,
      request = preparation.request.transaction;
    if (request.chain !== 'bitcoin' || Date.parse(preparation.expiresAt) <= Date.now())
      throw new ActionRejectedError('Batch preparation expired; retain original holds for review');
    await this.rpc.verifyNetwork('bitcoin');
    for (const u of request.utxos) {
      const raw = await this.rpc.call('bitcoin', 'gettxout', [u.txid, u.vout, true]);
      const output = z
        .object({
          value: z.union([z.string(), z.number()]),
          confirmations: z.number().int().nonnegative(),
          coinbase: z.boolean(),
          scriptPubKey: z.object({ hex: z.string() }),
        })
        .parse(raw);
      if (
        output.scriptPubKey.hex !== u.script ||
        bitcoinDecimalUnits(output.value) !== BigInt(u.amount) ||
        output.confirmations < 6 ||
        (output.coinbase && output.confirmations < 100)
      )
        throw new ActionRejectedError('Batch reserved input ownership, amount or maturity changed');
    }
  }

  async start(batchId: string) {
    this.enabled();
    const snapshot = await this.db.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
    });
    return this.db.$transaction(
      async (tx) => {
        await lock(tx, `custody-source:${snapshot.source_wallet_id}`);
        const context = await this.admission(tx, batchId);
        if (context.draft.state !== 'planned')
          throw new ActionRejectedError('Batch draft is closed');
        const existing = await tx.bitcoinBatchExecution.findUnique({
          where: { batch_id: batchId },
        });
        if (existing) return existing;
        await this.revalidate(context);
        const row = await tx.bitcoinBatchExecution.create({ data: { batch_id: batchId } });
        await enqueue(
          tx,
          QUEUES.ledger,
          {
            type: 'payout.batch.ledger.prepare',
            batchId,
            domainId: context.manifest.domainId,
            resetEpoch: context.manifest.resetEpoch,
            manifest: context.manifest,
            preparation: context.preparation,
          },
          `batch:${batchId}:prepare`,
        );
        return row;
      },
      { timeout: 30_000 },
    );
  }

  async handle(message: Message): Promise<boolean> {
    if ('operationId' in message && message.operationId && 'schemaVersion' in message) {
      const member = await this.db.withdrawalBatchDraftMember.findFirst({
        where: { withdrawal_id: message.operationId, active: true },
      });
      if (
        member &&
        (await this.db.bitcoinBatchExecution.findUnique({ where: { batch_id: member.batch_id } }))
      ) {
        const w = await this.db.withdrawal.findUniqueOrThrow({
          where: { id: member.withdrawal_id },
        });
        if (
          message.domainId !== w.domain_id ||
          message.resetEpoch !== this.auth.resetEpoch ||
          message.customerId !== w.customer_id ||
          message.requestDigest !== w.request_digest ||
          message.attemptId !== member.attempt_id
        )
          throw new ActionRejectedError('Batch member projection identity mismatch');
        // Financial projection is atomic across members from the aggregate acknowledgement below.
        if (['settlement.committed.v1', 'settlement.reversed.v1'].includes(message.type))
          return true;
      }
    }
    const id =
      'batchId' in message
        ? message.batchId
        : message.type === 'broadcast.updated'
          ? message.transactionId
          : undefined;
    if (
      !id ||
      ![
        'payout.batch.ledger.result',
        'payout.batch.signed',
        'payout.batch.rejected',
        'broadcast.updated',
      ].includes(message.type)
    )
      return false;
    const snapshot = await this.db.bitcoinBatchExecution.findUnique({ where: { batch_id: id } });
    if (!snapshot) return false;
    const draft = await this.db.withdrawalBatchDraft.findUniqueOrThrow({ where: { id } });
    await this.db.$transaction(
      async (tx) => {
        await lock(tx, `custody-source:${draft.source_wallet_id}`);
        const current = await tx.bitcoinBatchExecution.findUniqueOrThrow({
          where: { batch_id: id },
        });
        const context = await this.context(tx, id),
          { manifest, preparation } = context;
        if (message.type === 'payout.batch.ledger.result') {
          if (
            message.domainId !== manifest.domainId ||
            message.resetEpoch !== manifest.resetEpoch ||
            message.manifestDigest !== preparation.manifestDigest ||
            message.preparationDigest !== preparation.preparationDigest
          )
            throw new ActionRejectedError('Batch Ledger acknowledgement binding mismatch');
          if (message.revision < current.ledger_ack_revision) return;
          if (message.state === 'prepared') {
            if (message.revision !== 0)
              throw new ActionRejectedError('Invalid batch preparation revision');
            if (current.command) return;
            const admitted = await this.admission(tx, id);
            await this.revalidate(admitted);
            const command = bitcoinBatchSignSchema.parse({
              type: 'payout.batch.sign',
              transactionId: id,
              batchId: id,
              manifest,
              preparation,
              authorization: signBitcoinBatchAuthorization(
                {
                  version: 1,
                  purpose: 'bitcoin_withdrawal_batch',
                  domainId: manifest.domainId,
                  resetEpoch: manifest.resetEpoch,
                  seedId: manifest.seedId,
                  batchId: id,
                  transactionId: id,
                  manifestDigest: preparation.manifestDigest,
                  preparationDigest: preparation.preparationDigest,
                  sourcePath: admitted.source.path,
                  expiresAt: preparation.expiresAt,
                },
                this.settings.authorityPrivateKey!,
              ),
            });
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: id },
              data: { ledger_ack_revision: 0, command: json(command), state: 'signing' },
            });
            await enqueue(tx, QUEUES.signer, command, `batch:${id}:sign`);
          } else {
            if (message.revision !== current.revision || !current.canonical_command)
              throw new ActionRejectedError(
                'Batch Ledger result has no matching canonical request',
              );
            const command = current.canonical_command as unknown as PayoutBatchLedgerCommand;
            if ((message.state === 'settled') !== (command.type === 'payout.batch.ledger.settle'))
              throw new ActionRejectedError('Batch Ledger result outcome mismatch');
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: id },
              data: { ledger_ack_revision: message.revision },
            });
          }
        } else if (
          message.type === 'payout.batch.signed' ||
          message.type === 'payout.batch.rejected'
        ) {
          if (!current.command || !this.settings.signerPublicKey)
            throw new ActionRejectedError('Unexpected batch signer result');
          const claims = verifySignerAttestation(
            message.signerAttestation,
            bitcoinBatchAttestedResult(message),
            this.settings.signerPublicKey,
          );
          if (
            message.transactionId !== id ||
            message.manifestDigest !== preparation.manifestDigest ||
            message.preparationDigest !== preparation.preparationDigest ||
            claims.domainId !== manifest.domainId ||
            claims.resetEpoch !== manifest.resetEpoch
          )
            throw new ActionRejectedError('Batch signer attestation scope mismatch');
          if (message.type === 'payout.batch.rejected') {
            if (message.commandDigest !== executionDigest(current.command))
              throw new ActionRejectedError(
                'Rejection does not describe the retained original batch command',
              );
          } else if (
            verifyBitcoinPayment(preparation.request, message.signed).feeUnits !==
            preparation.feeUnits
          ) {
            throw new ActionRejectedError('Batch signed fee mismatch');
          }
          const digest = executionDigest(message);
          if (
            !(await tx.bitcoinBatchSignerResult.findUnique({
              where: { batch_id_digest: { batch_id: id, digest } },
            }))
          )
            await tx.bitcoinBatchSignerResult.create({
              data: { batch_id: id, digest, payload: json(message) },
            });
          if (current.signer_result) {
            if (
              executionDigest(current.signer_result) === digest ||
              message.type === 'payout.batch.rejected'
            )
              return;
            if ((current.signer_result as { type?: string }).type !== 'payout.batch.rejected')
              throw new ActionRejectedError('Batch signed result is immutable');
            // A delayed successful result can precede an expired retry's rejection.
            // Preserve both receipts; rejection never proves the original command was never signed.
          }
          if (message.type === 'payout.batch.rejected') {
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: id },
              data: {
                signer_result: json(message),
                state: 'attention',
                last_error: 'Signing rejected; original holds and history retained',
              },
            });
          } else {
            if (
              verifyBitcoinPayment(preparation.request, message.signed).feeUnits !==
              preparation.feeUnits
            )
              throw new ActionRejectedError('Batch signed fee mismatch');
            const updated = await tx.bitcoinBatchExecution.update({
              where: { batch_id: id },
              data: {
                signer_result: json(message),
                signed: json(message.signed),
                state: 'signed',
                last_error: null,
              },
            });
            for (const m of manifest.members)
              await tx.withdrawal.update({
                where: { id: m.operationId },
                data: {
                  state: 'executing',
                  transaction_hash: message.signed.txHash,
                  revision: { increment: 1 },
                },
              });
            // Retain signed evidence even if admission was paused after signing. Repair dispatches the same bytes only.
            try {
              await this.admission(tx, id);
              await this.queueBroadcast(tx, updated, context);
            } catch (error) {
              if (!(error instanceof ActionRejectedError)) throw error;
            }
          }
        } else if (message.type === 'broadcast.updated') {
          if (
            message.execution?.operationId !== id ||
            message.execution.attemptId !== id ||
            message.execution.requestDigest !== preparation.manifestDigest ||
            message.execution.preparationDigest !== preparation.preparationDigest ||
            !current.signed
          )
            throw new ActionRejectedError('Batch broadcast result identity mismatch');
          if (message.generation < current.broadcast_generation) return;
          if (message.generation > current.broadcast_generation)
            throw new ActionRejectedError('Unknown batch broadcast generation');
          // Broadcast progress is not payment proof. Wallet independently observes canonical bytes/inclusion.
          await tx.bitcoinBatchExecution.update({
            where: { batch_id: id },
            data: { next_check_at: new Date(), last_error: message.lastError },
          });
        }
      },
      { timeout: 30_000 },
    );
    return true;
  }

  private async queueBroadcast(
    tx: Prisma.TransactionClient,
    row: BitcoinBatchExecution,
    context: Awaited<ReturnType<BitcoinBatchExecutionService['context']>>,
    dedupeKey?: string,
  ) {
    if (!row.signed || !row.signer_result) return;
    if (dedupeKey && (await tx.outbox.findUnique({ where: { dedupe_key: dedupeKey } }))) return;
    const result = row.signer_result as unknown as Extract<
      Message,
      { type: 'payout.batch.signed' }
    >;
    const generation = row.broadcast_generation + 1;
    const { manifest, preparation } = context;
    const snapshot = broadcastSnapshotSchema.parse({
      chain: 'bitcoin',
      network: 'regtest',
      signed: row.signed,
      execution: {
        domainId: manifest.domainId,
        resetEpoch: manifest.resetEpoch,
        operationId: row.batch_id,
        attemptId: row.batch_id,
        requestDigest: preparation.manifestDigest,
        preparationDigest: preparation.preparationDigest,
        preparedRequest: preparation.request,
        bitcoinBatch: { manifest, preparation },
        signerAttestation: result.signerAttestation,
      },
    });
    await tx.bitcoinBatchExecution.update({
      where: { batch_id: row.batch_id },
      data: {
        broadcast_generation: generation,
        state: row.state === 'reverted' ? 'reverted' : 'submitted',
      },
    });
    await enqueue(
      tx,
      QUEUES.broadcast,
      { type: 'broadcast.requested', transactionId: row.batch_id, generation, snapshot },
      dedupeKey ?? `batch:${row.batch_id}:broadcast:${generation}`,
    );
  }

  async retrySigned(batchId: string, commandId: string) {
    const draft = await this.db.withdrawalBatchDraft.findUniqueOrThrow({ where: { id: batchId } });
    return this.db.$transaction(async (tx) => {
      await lock(tx, `custody-source:${draft.source_wallet_id}`);
      const context = await this.admission(tx, batchId);
      const row = await tx.bitcoinBatchExecution.findUniqueOrThrow({
        where: { batch_id: batchId },
      });
      if (!row.signed || ['settled', 'settlement_pending'].includes(row.state))
        throw new ActionRejectedError(
          'Batch has no retryable signed bytes; reconcile canonical accounting first',
        );
      await this.queueBroadcast(tx, row, context, `batch:${batchId}:manual:${commandId}`);
    });
  }

  async inspect(batchId: string) {
    const draft = await this.db.withdrawalBatchDraft.findFirst({
      where: { id: batchId, domain_id: this.config.domainId, reset_epoch: this.auth.resetEpoch },
      include: { preparation: { include: { execution: true } } },
    });
    if (!draft) throw new ActionRejectedError('Batch not found in the current custody scope');
    const manifest = payoutBatchManifestSchema.parse(draft.manifest),
      row = draft.preparation?.execution;
    return {
      batchId: draft.id,
      sourceWalletId: draft.source_wallet_id,
      state: row?.state ?? draft.state,
      manifestDigest: draft.manifest_digest,
      preparationDigest: draft.preparation?.preparation_digest ?? null,
      members: manifest.members.map((m) => ({
        withdrawalId: m.operationId,
        reservationId: m.reservationId,
        attemptId: m.attemptId,
        principalUnits: m.principalUnits,
      })),
      transactionHash: row?.signed ? signedSchema.parse(row.signed).txHash : null,
      canonicalRevision: row?.revision ?? 0,
      ledgerAcknowledgedRevision: row?.ledger_ack_revision ?? -1,
      terminalProofRevision: row?.terminal_proof_revision ?? 0,
      signerReceipts: row
        ? await this.db.bitcoinBatchSignerResult.count({ where: { batch_id: batchId } })
        : 0,
      nextCheckAt: row?.next_check_at ?? null,
      lastError: row?.last_error ?? null,
      history: row
        ? (
            await this.db.bitcoinBatchExecutionEvent.findMany({
              where: { batch_id: batchId },
              orderBy: { sequence: 'desc' },
              take: 50,
            })
          ).map((event) => ({
            sequence: event.sequence.toString(),
            digest: event.digest,
            createdAt: event.created_at,
            state: (event.snapshot as { state: string }).state,
          }))
        : [],
    };
  }

  async reconcile(batchId: string) {
    const snapshot = await this.db.bitcoinBatchExecution.findUniqueOrThrow({
      where: { batch_id: batchId },
    });
    if (!snapshot.signed) return;
    const draft = await this.db.withdrawalBatchDraft.findUniqueOrThrow({
      where: { id: batchId },
      include: { preparation: true },
    });
    const { manifest, preparation } = validateBitcoinBatch(
      draft.manifest,
      draft.preparation!.preparation,
    );
    if (manifest.domainId !== this.config.domainId || manifest.resetEpoch !== this.auth.resetEpoch)
      throw new ActionRejectedError('Batch reconciliation scope mismatch');
    const signed = signedSchema.parse(snapshot.signed);
    const observation = await new NativeSweepPlanner(this.rpc).observe({
      chain: 'bitcoin',
      network: 'regtest',
      hash: signed.txHash,
      request: preparation.request,
      signed,
      ...(snapshot.inclusion && snapshot.state !== 'reverted'
        ? { priorInclusion: inclusionSchema.parse(snapshot.inclusion) }
        : {}),
    });
    await this.db.$transaction(
      async (tx) => {
        await lock(tx, `custody-source:${manifest.sourceWalletId}`);
        const row = await tx.bitcoinBatchExecution.findUniqueOrThrow({
          where: { batch_id: batchId },
        });
        if (
          row.revision !== snapshot.revision ||
          row.state !== snapshot.state ||
          row.ledger_ack_revision !== snapshot.ledger_ack_revision
        )
          return;
        if (observation.state === 'reverted') {
          if (row.state === 'reverted') return;
          if (row.revision > 0) {
            const revision = row.revision + 1;
            const command: PayoutBatchLedgerCommand = {
              type: 'payout.batch.ledger.revert',
              batchId,
              domainId: manifest.domainId,
              resetEpoch: manifest.resetEpoch,
              revision,
              priorSettlementRevision: row.revision,
              reason: 'Canonical batch inclusion orphaned',
            };
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: batchId },
              data: { state: 'reverted', revision, canonical_command: json(command) },
            });
            await enqueue(tx, QUEUES.ledger, command, `batch:${batchId}:canonical:${revision}`);
            for (const m of manifest.members)
              await tx.withdrawal.update({
                where: { id: m.operationId },
                data: {
                  state: 'reconciliation_required',
                  settlement_revision: revision,
                  revision: { increment: 1 },
                },
              });
          }
          await tx.custodyDomain.update({
            where: { id: manifest.domainId },
            data: { status: 'paused' },
          });
        } else if (observation.state === 'confirmed') {
          const inclusion = inclusionSchema.parse(observation);
          if (inclusion.actualFeeUnits !== preparation.feeUnits)
            throw new ActionRejectedError('Canonical batch fee mismatch');
          if (
            row.state === 'settled' &&
            executionDigest(row.inclusion) === executionDigest(inclusion)
          ) {
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: batchId },
              data: { next_check_at: new Date(Date.now() + this.settings.pollIntervalMs) },
            });
            return;
          }
          if (row.state === 'settlement_pending' || row.state === 'settled') {
            if (row.ledger_ack_revision === row.revision && row.revision > 0) {
              await tx.bitcoinBatchExecution.update({
                where: { batch_id: batchId },
                data: {
                  state: 'settled',
                  inclusion: json(inclusion),
                  terminal_proof_revision: row.revision,
                },
              });
              for (const m of manifest.members)
                await tx.withdrawal.update({
                  where: { id: m.operationId },
                  data: {
                    state: 'settled',
                    settlement_revision: row.revision,
                    revision: { increment: 1 },
                    transaction_hash: signed.txHash,
                  },
                });
              if (draft.state === 'planned')
                await tx.withdrawalBatchDraft.update({
                  where: { id: batchId },
                  data: { state: 'completed' },
                });
            }
          } else {
            // Wait for reversal accounting before publishing a newer re-inclusion.
            if (row.state === 'reverted' && row.ledger_ack_revision !== row.revision) return;
            const revision = row.revision + 1;
            const command: PayoutBatchLedgerCommand = {
              type: 'payout.batch.ledger.settle',
              batchId,
              domainId: manifest.domainId,
              resetEpoch: manifest.resetEpoch,
              revision,
              transactionHash: signed.txHash,
              actualFeeUnits: inclusion.actualFeeUnits,
              blockHash: inclusion.blockHash,
              blockHeight: inclusion.blockHeight,
            };
            await tx.bitcoinBatchExecution.update({
              where: { batch_id: batchId },
              data: {
                state: 'settlement_pending',
                revision,
                inclusion: json(inclusion),
                canonical_command: json(command),
              },
            });
            await enqueue(tx, QUEUES.ledger, command, `batch:${batchId}:canonical:${revision}`);
          }
        } else if (observation.state === 'pending' && ['signed', 'submitted'].includes(row.state)) {
          try {
            await this.admission(tx, batchId);
            await this.queueBroadcast(tx, row, { manifest, preparation, draft });
          } catch (error) {
            if (!(error instanceof ActionRejectedError)) throw error;
          }
        }
        await tx.bitcoinBatchExecution.update({
          where: { batch_id: batchId },
          data: { next_check_at: new Date(Date.now() + this.settings.pollIntervalMs) },
        });
      },
      { timeout: 30_000 },
    );
  }

  async repairDue() {
    if (!this.config.domainId) return;
    if (this.settings.bitcoinBatchesEnabled) await this.schedule();
    const rows = await this.db.bitcoinBatchExecution.findMany({
      where: {
        next_check_at: { lte: new Date() },
        preparation: {
          batch: { domain_id: this.config.domainId, reset_epoch: this.auth.resetEpoch },
        },
      },
      orderBy: [{ next_check_at: 'asc' }, { batch_id: 'asc' }],
      take: 40,
    });
    for (const row of rows) {
      try {
        if (row.signed) {
          await this.reconcile(row.batch_id);
          const current = await this.db.bitcoinBatchExecution.findUniqueOrThrow({
            where: { batch_id: row.batch_id },
          });
          if (current.canonical_command && current.ledger_ack_revision < current.revision)
            await enqueue(
              this.db,
              QUEUES.ledger,
              current.canonical_command as unknown as PayoutBatchLedgerCommand,
              `batch:${row.batch_id}:canonical:${current.revision}:repair:${Math.floor(Date.now() / this.settings.pollIntervalMs)}`,
            );
        } else
          await this.db.$transaction(async (tx) => {
            const context = await this.context(tx, row.batch_id);
            await lock(tx, `custody-source:${context.manifest.sourceWalletId}`);
            const current = await tx.bitcoinBatchExecution.findUniqueOrThrow({
              where: { batch_id: row.batch_id },
            });
            if (current.signed || current.signer_result) return;
            if (current.command)
              await enqueue(
                tx,
                QUEUES.signer,
                bitcoinBatchSignSchema.parse(current.command),
                `batch:${row.batch_id}:sign:repair:${Math.floor(Date.now() / this.settings.pollIntervalMs)}`,
              );
            else
              await enqueue(
                tx,
                QUEUES.ledger,
                {
                  type: 'payout.batch.ledger.prepare',
                  batchId: row.batch_id,
                  domainId: context.manifest.domainId,
                  resetEpoch: context.manifest.resetEpoch,
                  manifest: context.manifest,
                  preparation: context.preparation,
                },
                `batch:${row.batch_id}:prepare:repair:${Math.floor(Date.now() / this.settings.pollIntervalMs)}`,
              );
          });
      } catch {
        // Never reinterpret an outage, expiry or rejection as proof permitting a release/replacement.
      } finally {
        await this.db.bitcoinBatchExecution.update({
          where: { batch_id: row.batch_id },
          data: { next_check_at: new Date(Date.now() + this.settings.pollIntervalMs) },
        });
      }
    }
  }

  private async schedule() {
    this.enabled();
    const domainId = this.config.domainId;
    if (!domainId) throw new ActionRejectedError('Missing custody domain');
    const sources = await this.db.wallet.findMany({
      where: {
        custody_domain_id: domainId,
        reset_epoch: this.auth.resetEpoch,
        chain: 'bitcoin',
        network: 'regtest',
        custody_role: 'hot',
        account: 0,
        active: true,
        status: 'ready',
      },
      take: 10,
    });
    for (const source of sources) {
      try {
        let draft = await this.db.withdrawalBatchDraft.findFirst({
          where: { source_wallet_id: source.id, state: 'planned' },
        });
        if (!draft) {
          const rows = await this.db.withdrawal.findMany({
            where: {
              hot_wallet_id: source.id,
              state: 'queued',
              customer: { state: 'active', ledger_status: 'ready' },
              batch_draft_id: null,
              attempt_id: null,
              cancel_requested: false,
              reservation_id: { not: null },
              asset_id: 'token:bitcoin:native',
            },
            orderBy: { id: 'asc' },
            take: 50,
          });
          if (rows.length < 2) continue;
          const asset = await this.db.assetConfiguration.findUniqueOrThrow({
            where: {
              domain_id_chain_network_asset_id: {
                domain_id: domainId,
                chain: 'bitcoin',
                network: 'regtest',
                asset_id: 'token:bitcoin:native',
              },
            },
          });
          const manifest = payoutBatchManifestSchema.parse({
            version: 1,
            batchId: randomUUID(),
            domainId: domainId,
            resetEpoch: this.auth.resetEpoch,
            seedId: this.config.seedId,
            sourceWalletId: source.id,
            sourceRegistryRevision: source.registry_revision,
            sourceAddress: source.address,
            asset: { chain: 'bitcoin', network: 'regtest', assetId: 'token:bitcoin:native' },
            feeAllocation: 'equal-largest-remainder-v1',
            members: rows.map((w) => ({
              operationId: w.id,
              attemptId: randomUUID(),
              reservationId: w.reservation_id!,
              customerId: w.customer_id,
              requestDigest: w.request_digest,
              destination: w.destination,
              principalUnits: w.principal_units,
              maximumFeeUnits: asset.maximum_fee_units,
              maximumRentUnits: '0',
            })),
          });
          draft = await this.drafts.claim(manifest);
        }
        if (!(await this.db.bitcoinBatchExecution.findUnique({ where: { batch_id: draft.id } }))) {
          const retained = await this.db.withdrawalBatchPreparation.findUnique({
            where: { batch_id: draft.id },
          });
          if (retained && retained.expires_at <= new Date()) {
            await this.drafts.releaseUnsigned(draft.id);
            continue;
          }
          await this.drafts.prepareBitcoin(draft.id);
          await this.start(draft.id);
        }
      } catch {
        /* Keep existing source/resource owners and retry the bounded group next tick. */
      }
    }
  }
}
