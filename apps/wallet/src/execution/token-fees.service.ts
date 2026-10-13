import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lock } from '../../../../packages/database/src/locks.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { SweepDeferral } from '../../../../packages/chain/src/native-sweep-planner.js';
import {
  executionDigest,
  executionUnitsSchema,
} from '../../../../packages/shared/src/execution-authorization.js';
import {
  tokenAsset,
  tokenCertificateSchema,
} from '../../../../packages/shared/src/token-contracts.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';

export const tokenFeeRequestSchema = z
  .object({
    domainId: z.string().min(1).max(128),
    resetEpoch: z.string().min(1).max(128),
    customerId: z.uuid(),
    sourceWalletId: z.uuid(),
    managementWalletId: z.uuid(),
    sourceRegistryRevision: z.number().int().positive(),
    managementRegistryRevision: z.number().int().positive(),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    generation: z.number().int().positive(),
    certificate: tokenCertificateSchema,
    kind: z.enum(['gas_funding', 'spl_sponsorship']),
    principalUnits: executionUnitsSchema,
    maximumFeeUnits: executionUnitsSchema.refine((v) => BigInt(v) > 0n),
    maximumRentUnits: executionUnitsSchema,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.kind === 'gas_funding'
        ? r.certificate.standard !== 'erc20' ||
          r.maximumRentUnits !== '0' ||
          r.principalUnits === '0'
        : r.certificate.standard !== 'spl' || r.principalUnits !== '0'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Fee dependency does not match supported token operation',
      });
  });
export type TokenFeeRequest = z.infer<typeof tokenFeeRequestSchema>;
const pending = ['reserved', 'uncertain', 'reverted'];
const units = (v: string) => BigInt(executionUnitsSchema.parse(v));
const deferred = (reason: string): never => {
  throw new SweepDeferral('waiting_funds', reason);
};

/** Wallet-owned budget reservation only. A reservation never grants signing permission. */
@Injectable()
export class TokenFeesService {
  constructor(
    private readonly db: WalletPrismaService,
    private readonly rpc: ChainRpcService,
  ) {}

  async reserve(input: TokenFeeRequest, transaction?: Prisma.TransactionClient) {
    const request = tokenFeeRequestSchema.parse(input),
      asset = tokenAsset(request.certificate);
    if (this.rpc.networkIdentity(asset.chain) !== asset.network)
      return deferred('Funding RPC identity mismatch');
    await this.rpc.verifyNetwork(asset.chain);
    const management = await this.db.wallet.findUniqueOrThrow({
      where: { id: request.managementWalletId },
    });
    const reserve = async (tx: Prisma.TransactionClient) => {
      // All workers reserve against the same network balance and rolling budget.
      await lock(
        tx,
        `token-fee-budget:${request.domainId}:${request.resetEpoch}:${asset.chain}:${asset.network}`,
      );
      const dependencyKey = executionDigest([
        request.domainId,
        request.resetEpoch,
        request.sourceWalletId,
        asset.assetId,
        request.generation,
        request.kind,
        request.operationId,
      ]);
      const requestDigest = executionDigest(request);
      const existing = await tx.tokenFeeReservation.findUnique({
        where: { dependency_key: dependencyKey },
      });
      if (existing) {
        if (existing.request_digest !== requestDigest)
          return deferred('Funding dependency is immutable');
        return existing;
      }
      await tx.$queryRaw`SELECT id FROM custody_domains WHERE id=${request.domainId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${request.sourceWalletId}::uuid,${request.managementWalletId}::uuid) ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT domain_id FROM management_wallet_purposes WHERE domain_id=${request.domainId} AND chain=${asset.chain} AND network=${asset.network} AND account=1 FOR UPDATE`;
      await tx.$queryRaw`SELECT wallet_id FROM exchange_wallet_registry WHERE wallet_id IN (${request.sourceWalletId}::uuid,${request.managementWalletId}::uuid) ORDER BY wallet_id FOR UPDATE`;
      await tx.$queryRaw`SELECT domain_id FROM asset_configurations WHERE domain_id=${request.domainId} AND chain=${asset.chain} AND network=${asset.network} AND asset_id=${asset.assetId} FOR UPDATE`;
      const [source, payer, customer, domain, configuration, policy] = await Promise.all([
        tx.wallet.findUnique({ where: { id: request.sourceWalletId } }),
        tx.wallet.findUnique({ where: { id: request.managementWalletId } }),
        tx.exchangeCustomer.findUnique({ where: { customer_id: request.customerId } }),
        tx.custodyDomain.findUnique({ where: { id: request.domainId } }),
        tx.assetConfiguration.findUnique({
          where: {
            domain_id_chain_network_asset_id: {
              domain_id: request.domainId,
              chain: asset.chain,
              network: asset.network,
              asset_id: asset.assetId,
            },
          },
        }),
        tx.managementWalletPurpose.findUnique({
          where: {
            domain_id_chain_network_account: {
              domain_id: request.domainId,
              chain: asset.chain,
              network: asset.network,
              account: 1,
            },
          },
        }),
      ]);
      if (
        !source ||
        !payer ||
        !source.active ||
        !payer.active ||
        !source.published_at ||
        !payer.published_at ||
        source.custody_role !== 'customer_deposit' ||
        source.account < 10 ||
        source.customer_id !== request.customerId ||
        payer.custody_role !== 'management' ||
        payer.account !== 1 ||
        payer.id === source.id ||
        [source, payer].some(
          (w) =>
            w.custody_domain_id !== request.domainId ||
            w.reset_epoch !== request.resetEpoch ||
            w.chain !== asset.chain ||
            w.network !== asset.network,
        ) ||
        source.seed_id !== payer.seed_id ||
        payer.address !== management.address ||
        source.registry_revision !== request.sourceRegistryRevision ||
        payer.registry_revision !== request.managementRegistryRevision ||
        customer?.state !== 'active' ||
        customer.ledger_status !== 'ready' ||
        customer.reset_epoch !== request.resetEpoch ||
        customer.domain_id !== request.domainId ||
        domain?.status !== 'active' ||
        domain.reset_epoch !== request.resetEpoch ||
        domain.policy_version !== 'exchange-financial-v1' ||
        !configuration?.sweep_enabled ||
        configuration.standard !== request.certificate.standard ||
        configuration.decimals !== request.certificate.decimals ||
        (request.certificate.standard === 'erc20'
          ? configuration.contract_address !== request.certificate.contract
          : configuration.mint !== request.certificate.mint ||
            configuration.token_program !== request.certificate.programId) ||
        configuration.policy_version !== 'exchange-financial-v1' ||
        !configuration.transfer_certificate ||
        executionDigest(configuration.transfer_certificate) !==
          executionDigest(request.certificate) ||
        !policy ||
        policy.purpose !== payer.management_purpose ||
        policy.policy_version !== 'exchange-financial-v1' ||
        !Array.isArray(policy.permitted_actions) ||
        !policy.permitted_actions.includes(
          request.kind === 'gas_funding' ? 'funding' : 'fee-sponsorship',
        ) ||
        (BigInt(request.maximumRentUnits) > 0n &&
          !policy.permitted_actions.includes('account-setup'))
      )
        return deferred('Published token, customer or management1 authority is not ready');
      const registries = await tx.exchangeWalletRegistry.findMany({
        where: { wallet_id: { in: [source.id, payer.id] } },
      });
      if (
        registries.length !== 2 ||
        registries.some(
          (r) =>
            r.domain_id !== request.domainId ||
            r.reset_epoch !== request.resetEpoch ||
            r.ledger_status !== 'ready' ||
            r.registry_revision !==
              (r.wallet_id === source.id ? source.registry_revision : payer.registry_revision) ||
            r.ledger_ack_revision !== r.registry_revision ||
            (r.wallet_id === source.id && (!r.ready || r.listener_ack_revision <= 0)),
        )
      )
        return deferred('Fee dependency requires current registry acknowledgments');
      const outstanding = await tx.tokenFeeReservation.findFirst({
        where: {
          domain_id: request.domainId,
          reset_epoch: request.resetEpoch,
          source_wallet_id: source.id,
          chain: asset.chain,
          network: asset.network,
          state: { in: pending },
        },
      });
      if (outstanding) {
        const prior = tokenFeeRequestSchema.parse(outstanding.request);
        if (
          request.kind === 'gas_funding' &&
          outstanding.kind === 'gas_funding' &&
          prior.generation === request.generation &&
          executionDigest(prior.certificate) === executionDigest(request.certificate)
        )
          return outstanding;
        return deferred('Customer wallet already has outstanding fee exposure');
      }
      const principal = units(request.principalUnits),
        fee = units(request.maximumFeeUnits),
        rent = units(request.maximumRentUnits),
        total = principal + fee + rent;
      const hard =
        asset.chain === 'ethereum'
          ? {
              operation: 5_000_000_000_000_000n,
              wallet: 10_000_000_000_000_000n,
              domain: 50_000_000_000_000_000n,
              fee: 5_000_000_000_000_000n,
              rent: 0n,
            }
          : {
              operation: 10_000_000n,
              wallet: 20_000_000n,
              domain: 100_000_000n,
              fee: 100_000n,
              rent: 10_000_000n,
            };
      if (
        !total ||
        (request.kind === 'spl_sponsorship' ? total : principal + rent) > hard.operation ||
        (request.kind === 'spl_sponsorship' ? total : principal + rent) >
          units(policy.maximum_operation_units) ||
        fee > hard.fee ||
        rent > hard.rent
      )
        return deferred('Fee dependency exceeds per-operation policy');
      const now = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const floor = new Date(now[0].now.getTime() - 86_400_000);
      const exposure = await tx.tokenFeeReservation.findMany({
        where: {
          domain_id: request.domainId,
          reset_epoch: request.resetEpoch,
          chain: asset.chain,
          network: asset.network,
          OR: [{ state: { in: pending } }, { state: 'settled', settled_at: { gte: floor } }],
        },
      });
      let walletTotal = total,
        domainTotal = total,
        pendingLiquidity = total;
      for (const row of exposure) {
        const amount = units(row.state === 'settled' ? row.actual_units! : row.reserved_units);
        domainTotal += amount;
        if (row.source_wallet_id === source.id) walletTotal += amount;
        if (pending.includes(row.state) && row.management_wallet_id === payer.id)
          pendingLiquidity += amount;
      }
      if (
        walletTotal > hard.wallet ||
        walletTotal > units(policy.maximum_customer_24h_units) ||
        domainTotal > hard.domain ||
        domainTotal > units(policy.maximum_domain_24h_units)
      )
        return deferred('Rolling fee budget exhausted; pending exposure is retained');
      const available = await this.available(asset.chain, payer.address!);
      if (pendingLiquidity > available)
        return deferred('Management native liquidity is reserved or insufficient');
      return tx.tokenFeeReservation.create({
        data: {
          id: randomUUID(),
          domain_id: request.domainId,
          reset_epoch: request.resetEpoch,
          customer_id: request.customerId,
          source_wallet_id: source.id,
          management_wallet_id: payer.id,
          chain: asset.chain,
          network: asset.network,
          dependency_key: dependencyKey,
          request_digest: requestDigest,
          kind: request.kind,
          principal_units: request.principalUnits,
          maximum_fee_units: request.maximumFeeUnits,
          maximum_rent_units: request.maximumRentUnits,
          reserved_units: total.toString(),
          state: 'reserved',
          request: request as Prisma.InputJsonValue,
        },
      });
    };
    return transaction ? reserve(transaction) : this.db.$transaction(reserve);
  }

  private async available(chain: 'ethereum' | 'solana', address: string) {
    if (chain === 'ethereum') {
      const balances = await Promise.all(
        ['finalized', 'pending'].map((tag) =>
          this.rpc.call(chain, 'eth_getBalance', [address, tag]),
        ),
      );
      const parsed = balances.map((v) =>
        BigInt(
          z
            .string()
            .regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/)
            .parse(v),
        ),
      );
      return parsed[0] < parsed[1] ? parsed[0] : parsed[1];
    }
    const result = z
      .object({
        value: z.object({
          owner: z.literal('11111111111111111111111111111111'),
          executable: z.literal(false),
          lamports: z.number().int().nonnegative().safe(),
          data: z.tuple([z.literal(''), z.literal('base64')]),
        }),
      })
      .parse(
        await this.rpc.call(chain, 'getAccountInfo', [
          address,
          { commitment: 'finalized', encoding: 'base64' },
        ]),
      );
    const rent = z
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(
        await this.rpc.call(chain, 'getMinimumBalanceForRentExemption', [
          0,
          { commitment: 'finalized' },
        ]),
      );
    return BigInt(Math.max(0, result.value.lamports - rent));
  }
}
