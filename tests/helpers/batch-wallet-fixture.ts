import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../../apps/wallet/src/prisma/prisma.service.js';
import { CustodyService } from '../../apps/wallet/src/custody/custody.service.js';
import { BatchDraftsService } from '../../apps/wallet/src/execution/batch-drafts.service.js';
import { MessageAuth } from '../../packages/queue/src/messages.js';
import { payoutBatchManifestSchema } from '../../packages/shared/src/payout-policy.js';
import { custodySettings, isolatedDatabase, testMnemonic } from './custody-fixture.js';
import { acceptanceRollout } from './rollout-fixture.js';
import { SigningCore } from '../../apps/signer/src/signing/signing.core.js';
import { BitcoinBatchPlanner } from '../../packages/chain/src/bitcoin-batch-planner.js';
import { ChainRpcService } from '../../packages/chain/src/chain-rpc.service.js';
import { regtestWitnessAddress } from '../../packages/chain/src/bitcoin-address.js';
import { Chain } from '../../packages/shared/src/contracts.js';
import { exchangeEventSchema } from '../../packages/queue/src/exchange-contracts.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
export type BatchHoldInput = {
  domainId: string;
  resetEpoch: string;
  hotId: string;
  address: string;
  customerId: string;
  operationId: string;
  destination: string;
  requestDigest: string;
  asset: { chain: 'bitcoin' | 'solana'; network: string; assetId: string };
};
export async function batchWalletFixture(
  chain: 'bitcoin' | 'solana' = 'bitcoin',
  provision?: (input: BatchHoldInput) => Promise<string>,
  memberCount = 3,
) {
  const isolated = await isolatedDatabase(databaseUrl!);
  const db = new WalletPrismaService({ databaseUrl: isolated.url });
  try {
    const domainId = 'batch-' + randomUUID(),
      config = custodySettings(domainId),
      auth = new MessageAuth('q'.repeat(64), randomUUID());
    const custody = new CustodyService(
      db,
      config,
      { domainId, apiKey: 'c'.repeat(64) },
      auth,
      acceptanceRollout,
    );
    const bootstrap = await custody.bootstrap(),
      hot = bootstrap.hotWallets.find((w) => w.chain === chain)!;
    const core = await SigningCore.create(
      testMnemonic,
      config.seedId,
      config.ethereumChainId,
      undefined,
      { domainId, chainNetworks: config.chainNetworks ?? {} },
    );
    let address: string, destination: string;
    try {
      address = core.derive({ seedId: config.seedId, chain, account: 0 }).address;
      destination = core.derive({ seedId: config.seedId, chain, account: 20 }).address;
    } finally {
      core.close();
    }
    await db.wallet.update({
      where: { id: hot.id },
      data: { address, status: 'ready', registry_revision: 1, published_at: new Date() },
    });
    await db.exchangeWalletRegistry.create({
      data: {
        wallet_id: hot.id,
        domain_id: domainId,
        reset_epoch: auth.resetEpoch,
        chain,
        network: hot.network,
        address,
        role: 'hot',
        account: 0,
        registry_revision: 1,
        ledger_status: 'ready',
        ledger_ack_revision: 1,
        request: {},
      },
    });
    const asset = { chain, network: hot.network, assetId: `token:${chain}:native` };
    await db.assetConfiguration.update({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: domainId,
          chain,
          network: hot.network,
          asset_id: asset.assetId,
        },
      },
      data: { withdrawal_enabled: true },
    });
    const members = [];
    for (let i = 0; i < memberCount; i++) {
      const id = randomUUID(),
        customerId = randomUUID();
      const reservationId = provision
        ? await provision({
            domainId,
            resetEpoch: auth.resetEpoch,
            hotId: hot.id,
            address,
            customerId,
            operationId: id,
            destination,
            requestDigest: 'a'.repeat(64),
            asset,
          })
        : randomUUID();
      const requestDigest = 'a'.repeat(64);
      await db.exchangeCustomer.create({
        data: {
          customer_id: customerId,
          external_id: customerId,
          domain_id: domainId,
          reset_epoch: auth.resetEpoch,
          ledger_status: 'ready',
        },
      });
      // Mirrored accepted hold fixture; planning must not alter or release any Ledger hold.
      await db.withdrawal.create({
        data: {
          id,
          customer_id: customerId,
          domain_id: domainId,
          reset_epoch: auth.resetEpoch,
          idempotency_key: id,
          request_digest: requestDigest,
          request: exchangeEventSchema.parse({
            eventId: randomUUID(),
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            domainId,
            resetEpoch: auth.resetEpoch,
            correlationId: id,
            causationId: null,
            aggregateId: id,
            revision: 1,
            customerId,
            operationId: id,
            requestDigest,
            policyVersion: 'exchange-financial-v1',
            type: 'withdrawal.reserve.requested.v1',
            data: {
              hotWalletId: hot.id,
              destination,
              amounts: [{ asset, amount: '1000' }],
              principal: { asset, amount: '1000' },
              quoteExpiresAt: new Date(Date.now() + 120000).toISOString(),
            },
          }),
          chain,
          network: hot.network,
          asset_id: asset.assetId,
          destination,
          principal_units: '1000',
          policy_version: 'exchange-financial-v1',
          hot_wallet_id: hot.id,
          hot_registry_revision: 1,
          reservation_id: reservationId,
          state: 'queued',
        },
      });
      members.push({
        operationId: id,
        attemptId: randomUUID(),
        reservationId,
        customerId,
        requestDigest,
        destination,
        principalUnits: '1000',
        maximumFeeUnits: '1000',
        maximumRentUnits: '0',
      });
    }
    members.sort((a, b) => a.operationId.localeCompare(b.operationId));
    const manifest = payoutBatchManifestSchema.parse({
      version: 1,
      batchId: randomUUID(),
      domainId,
      resetEpoch: auth.resetEpoch,
      seedId: config.seedId,
      sourceWalletId: hot.id,
      sourceRegistryRevision: 1,
      sourceAddress: address,
      asset,
      members,
      feeAllocation: 'equal-largest-remainder-v1',
    });
    const rpc = new (class extends ChainRpcService {
      override async call(_chain: Chain, method: string, _params: unknown[]): Promise<unknown> {
        if (method === 'getblockchaininfo') return { chain: 'regtest' };
        if (method === 'listunspent')
          return [{ txid: 'a'.repeat(64), vout: 0, address, confirmations: 6 }];
        if (method === 'gettxout')
          return {
            value: '0.001',
            confirmations: 6,
            coinbase: false,
            scriptPubKey: {
              address,
              hex: '0014' + Buffer.from(regtestWitnessAddress(address).program).toString('hex'),
            },
          };
        if (method === 'estimatesmartfee') return { feerate: '0.00002' };
        throw new Error(`Unexpected batch fixture RPC ${method}`);
      }
    })({
      ethereumChainId: '11155111',
      solanaGenesisHash: 'unused',
      chainNetworks: config.chainNetworks,
    });
    const planner = new BitcoinBatchPlanner(rpc);
    const service = new BatchDraftsService(db, config, auth, planner);
    return {
      db,
      manifest,
      service,
      hot,
      planner,
      custody,
      config,
      auth,
      rpc,
      close: async () => {
        await db.$disconnect();
        await isolated.drop();
      },
    };
  } catch (error) {
    await db.$disconnect();
    await isolated.drop();
    throw error;
  }
}
