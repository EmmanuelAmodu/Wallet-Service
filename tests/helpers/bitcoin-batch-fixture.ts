import { randomUUID } from 'node:crypto';
import { SigningCore } from '../../apps/signer/src/signing/signing.core.js';
import { ChainRpcService } from '../../packages/chain/src/chain-rpc.service.js';
import { BitcoinBatchPlanner } from '../../packages/chain/src/bitcoin-batch-planner.js';
import { regtestWitnessAddress } from '../../packages/chain/src/bitcoin-address.js';
import { Chain } from '../../packages/shared/src/contracts.js';
import { payoutBatchManifestSchema } from '../../packages/shared/src/payout-policy.js';

export async function bitcoinBatchFixture(core: SigningCore, domainId: string, resetEpoch: string) {
  const source = core.derive({ chain: 'bitcoin', seedId: core.seedId, account: 0 }),
    recipient = core.derive({ chain: 'bitcoin', seedId: core.seedId, account: 10 });
  const manifest = payoutBatchManifestSchema.parse({
    version: 1,
    batchId: randomUUID(),
    domainId,
    resetEpoch,
    seedId: core.seedId,
    sourceWalletId: randomUUID(),
    sourceRegistryRevision: 1,
    sourceAddress: source.address,
    asset: { chain: 'bitcoin', network: 'regtest', assetId: 'token:bitcoin:native' },
    feeAllocation: 'equal-largest-remainder-v1',
    members: Array.from({ length: 3 }, () => ({
      operationId: randomUUID(),
      attemptId: randomUUID(),
      reservationId: randomUUID(),
      customerId: randomUUID(),
      requestDigest: 'a'.repeat(64),
      destination: recipient.address,
      principalUnits: '1000',
      maximumFeeUnits: '1000',
      maximumRentUnits: '0',
    })).sort((a, b) => a.operationId.localeCompare(b.operationId)),
  });
  const rpc = new (class extends ChainRpcService {
    override async call(_chain: Chain, method: string, _params: unknown[]): Promise<unknown> {
      if (method === 'getblockchaininfo') return { chain: 'regtest' };
      if (method === 'listunspent')
        return [{ txid: 'a'.repeat(64), vout: 0, address: source.address, confirmations: 6 }];
      if (method === 'gettxout')
        return {
          value: '0.001',
          confirmations: 6,
          coinbase: false,
          scriptPubKey: {
            address: source.address,
            hex:
              '0014' + Buffer.from(regtestWitnessAddress(source.address).program).toString('hex'),
          },
        };
      if (method === 'estimatesmartfee') return { feerate: '0.00002' };
      throw new Error(`Unexpected fixture RPC ${method}`);
    }
  })({
    ethereumChainId: 'unused',
    solanaGenesisHash: 'unused',
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  });
  return { manifest, preparation: await new BitcoinBatchPlanner(rpc).plan(manifest), source };
}
