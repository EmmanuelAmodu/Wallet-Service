import { Injectable } from '@nestjs/common';
import { ChainRpcService } from './chain-rpc.service.js';
import { NativeSweepPlanner, SweepDeferral } from './native-sweep-planner.js';
import { regtestWitnessAddress } from './bitcoin-address.js';
import { SignRequest, signSchema } from '../../shared/src/contracts.js';
import { executionDigest } from '../../shared/src/execution-authorization.js';
import { validateBitcoinBatch } from '../../shared/src/bitcoin-batch-contracts.js';
import {
  PayoutBatchManifest,
  payoutBatchManifestSchema,
  payoutBatchDigest,
  allocateBatchCosts,
  mapBatchOutputs,
} from '../../shared/src/payout-policy.js';

/** Unsigned preparation only. The result is not a spending permit or an input reservation. */
@Injectable()
export class BitcoinBatchPlanner {
  private readonly native: NativeSweepPlanner;
  constructor(rpc: ChainRpcService) {
    this.native = new NativeSweepPlanner(rpc);
  }

  async plan(input: PayoutBatchManifest) {
    const manifest = payoutBatchManifestSchema.parse(input);
    if (manifest.asset.chain !== 'bitcoin')
      throw new SweepDeferral('attention', 'Bitcoin batch preparation requires native regtest');
    const addresses = [manifest.sourceAddress, ...manifest.members.map((m) => m.destination)];
    for (const address of addresses) {
      const decoded = regtestWitnessAddress(address);
      if (decoded.address !== address || decoded.program.length !== 20)
        throw new SweepDeferral('attention', 'Bitcoin batch preparation requires canonical P2WPKH');
    }
    const principal = manifest.members.reduce((sum, m) => sum + BigInt(m.principalUnits), 0n);
    const quote = await this.native.plan({
      chain: 'bitcoin',
      network: 'regtest',
      sourceAddress: manifest.sourceAddress,
      hotAddress: manifest.members[0].destination,
      amount: principal.toString(),
    });
    if (quote.request.chain !== 'bitcoin' || quote.request.changeAmount === undefined)
      throw new Error('Bitcoin batch quote must retain exact change');
    // Each extra P2WPKH output adds 31 bytes. Reserve two bytes per input for
    // signature-size variation plus two bytes of transaction framing margin.
    // Real signed vsize and current mempool policy must still pass before broadcast.
    const extraBytes = 31 * (manifest.members.length - 1) + 2 * quote.request.utxos.length + 2;
    const extraFee = BigInt(extraBytes) * BigInt(quote.request.satsPerVbyte);
    const change = BigInt(quote.request.changeAmount) - extraFee;
    if (change < 546n)
      throw new SweepDeferral(
        'waiting_funds',
        'Bitcoin batch needs mature inputs and nondust change',
      );
    const fee = BigInt(quote.maxFeeUnits) + extraFee;
    if (fee > 10_000n)
      throw new SweepDeferral('fee_budget', 'Bitcoin batch exceeds the pinned transaction fee cap');
    let costs: ReturnType<typeof allocateBatchCosts>;
    try {
      costs = allocateBatchCosts(manifest, fee.toString());
    } catch {
      throw new SweepDeferral('fee_budget', 'Bitcoin batch exceeds an original member fee budget');
    }
    const request: SignRequest = signSchema.parse({
      wallet: {
        chain: 'bitcoin',
        network: 'regtest',
        seedId: manifest.seedId,
        account: 0,
        address: manifest.sourceAddress,
      },
      transaction: {
        ...quote.request,
        outputs: manifest.members.map((m) => ({
          address: m.destination,
          amount: m.principalUnits,
        })),
        changeAmount: change.toString(),
      },
    });
    const preparation = {
      version: 1 as const,
      batchId: manifest.batchId,
      manifestDigest: payoutBatchDigest(manifest),
      request,
      requestDigest: executionDigest(request),
      principalUnits: principal.toString(),
      feeUnits: fee.toString(),
      changeUnits: change.toString(),
      changeOutputIndex: 1,
      memberOutputs: mapBatchOutputs(manifest, change.toString()),
      memberCosts: costs,
      resourceKeys: quote.resourceKeys,
      expiresAt: quote.expiresAt,
    };
    return validateBitcoinBatch(manifest, {
      ...preparation,
      preparationDigest: executionDigest(preparation),
    }).preparation;
  }
}
