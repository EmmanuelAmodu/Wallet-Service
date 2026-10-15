import { Injectable } from '@nestjs/common';
import { CustodyExecution, Prisma, Wallet } from '@prisma/client';
import { z } from 'zod';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { SweepDeferral } from '../../../../packages/chain/src/native-sweep-planner.js';
import {
  planEvmWindow,
  EvmWindowAllocation,
} from '../../../../packages/shared/src/payout-policy.js';
import { lock } from '../../../../packages/database/src/locks.js';

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

@Injectable()
export class EvmLiquidityService {
  constructor(private readonly rpc: ChainRpcService) {}

  /** Caller holds the source transaction lock through preparation and outbox publication. */
  async reserve(
    tx: Prisma.TransactionClient,
    execution: CustodyExecution,
    source: Wallet,
    nonce: string,
    maximumFeeUnits: string,
  ) {
    const plan = execution.plan as {
      type: string;
      data: { asset: { assetId: string }; amount: string };
    };
    if (plan.type !== 'withdrawal.plan.requested.v1' || source.chain !== 'ethereum') return;
    if (
      source.custody_role !== 'hot' ||
      source.account !== 0 ||
      source.network !== '11155111' ||
      !source.address
    )
      throw new Error('EVM liquidity requires the registered Sepolia hot source');
    await lock(tx, `custody-source:${source.id}`);
    const previous = await tx.evmLiquidityReservation.findUnique({
      where: { execution_id: execution.id },
    });
    if (previous) {
      if (
        previous.nonce !== nonce ||
        previous.maximum_fee_units !== maximumFeeUnits ||
        previous.principal_units !== plan.data.amount ||
        previous.asset_id !== plan.data.asset.assetId ||
        previous.request_digest !== execution.request_digest ||
        previous.state !== 'reserved'
      )
        throw new Error('EVM liquidity allocation is immutable or no longer reserved');
      return previous;
    }
    await this.rpc.verifyNetwork('ethereum');
    const address = source.address.toLowerCase();
    const retained = await tx.evmLiquidityReservation.findMany({
      where: { source_wallet_id: source.id, state: { in: ['reserved', 'reverted'] } },
      include: { execution: { include: { transaction: true } } },
    });
    if (retained.some((r) => r.state === 'reverted'))
      throw new SweepDeferral(
        'paused_review',
        'Reverted EVM liquidity exposure requires reconciliation',
      );
    const [latest, pending, finalizedBalance, pendingBalance] = await Promise.all([
      this.rpc.call('ethereum', 'eth_getTransactionCount', [address, 'latest']),
      this.rpc.call('ethereum', 'eth_getTransactionCount', [address, 'pending']),
      this.rpc.call('ethereum', 'eth_getBalance', [address, 'finalized']),
      this.rpc.call('ethereum', 'eth_getBalance', [address, 'pending']),
    ]);
    const tokenBalances = new Map<string, { finalizedUnits: string; pendingUnits: string }>();
    for (const assetId of new Set([...retained.map((r) => r.asset_id), plan.data.asset.assetId])) {
      if (assetId === 'token:ethereum:native') continue;
      const match = /^token:ethereum:erc20:(0x[0-9a-f]{40})$/.exec(assetId);
      if (!match) throw new Error('Unsupported EVM liquidity asset');
      const data = '0x70a08231' + address.slice(2).padStart(64, '0');
      const [a, b] = await Promise.all(
        ['finalized', 'pending'].map((tag) =>
          this.rpc.call('ethereum', 'eth_call', [{ to: match[1], data }, tag]),
        ),
      );
      tokenBalances.set(assetId, {
        finalizedUnits: BigInt(word.parse(a)).toString(),
        pendingUnits: BigInt(word.parse(b)).toString(),
      });
    }
    const allocations: EvmWindowAllocation[] = retained.map((r) => ({
      attemptId: r.execution.attempt_id,
      nonce: r.nonce,
      assetId: r.asset_id,
      principalUnits: r.principal_units,
      maximumFeeUnits: r.maximum_fee_units,
      state: r.execution.transaction.signed ? 'uncertain' : 'prepared',
    }));
    const snapshot = {
      latestNonce: BigInt(quantity.parse(latest)).toString(),
      pendingNonce: BigInt(quantity.parse(pending)).toString(),
      nativeFinalizedUnits: BigInt(quantity.parse(finalizedBalance)).toString(),
      nativePendingUnits: BigInt(quantity.parse(pendingBalance)).toString(),
      tokenBalances,
    };
    let allocation: EvmWindowAllocation;
    try {
      // Keep the existing one-source window until replacement/winner gates are complete.
      allocation = planEvmWindow(
        snapshot,
        allocations,
        {
          attemptId: execution.attempt_id,
          assetId: plan.data.asset.assetId,
          principalUnits: plan.data.amount,
          maximumFeeUnits,
        },
        1,
      );
    } catch (error) {
      throw new SweepDeferral(
        'waiting_resources',
        error instanceof Error ? error.message : 'EVM liquidity reservation unavailable',
      );
    }
    if (allocation.nonce !== nonce)
      throw new SweepDeferral('waiting_resources', 'Canonical nonce changed before allocation');
    if (
      await tx.evmLiquidityReservation.findFirst({
        where: { source_wallet_id: source.id, nonce, state: { not: 'unsigned_released' } },
      })
    )
      throw new SweepDeferral(
        'paused_review',
        'Nonce belongs to a previously signed obligation; reconcile canonical history before reusing resources',
      );
    return tx.evmLiquidityReservation.create({
      data: {
        execution_id: execution.id,
        source_wallet_id: source.id,
        domain_id: execution.domain_id,
        reset_epoch: execution.reset_epoch,
        seed_id: source.seed_id,
        network: source.network,
        nonce,
        asset_id: allocation.assetId,
        principal_units: allocation.principalUnits,
        maximum_fee_units: maximumFeeUnits,
        request_digest: execution.request_digest,
        evidence: { ...snapshot, tokenBalances: [...tokenBalances] } as Prisma.InputJsonValue,
      },
    });
  }
}
