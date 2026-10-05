import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../apps/wallet/src/prisma/prisma.service.js';
import { CustodyService } from '../apps/wallet/src/custody/custody.service.js';
import { UserPrismaService } from '../apps/user/src/prisma/prisma.service.js';
import { LedgerPrismaService } from '../apps/ledger/src/prisma/prisma.service.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { ChainNetworkMap } from '../packages/chain/src/config.js';
import { canonicalizeDerivedAddress } from '../packages/chain/src/coin-metadata.js';
import { QUEUES, walletDeriveSchema, walletDerivedSchema } from '../packages/queue/src/messages.js';
import type {
  ResetRehearsalContext,
  ResetBootstrapAcceptance,
} from './rehearse-development-reset.js';
import { localDatabaseName } from './reset-development.js';

// This fixture exercises actual custody allocation and Signer binding after a real
// isolated reset. Production workflow/registry readiness is verified separately.
export async function bootstrapResetRehearsal(
  context: ResetRehearsalContext,
): Promise<ResetBootstrapAcceptance> {
  const environment = context.environment;
  for (const [name, service] of [
    ['WALLET_DATABASE_URL', 'wallet'],
    ['USER_DATABASE_URL', 'user'],
    ['LEDGER_DATABASE_URL', 'ledger'],
  ]) {
    const database = localDatabaseName(environment[name]!);
    assert.match(database, new RegExp(`^waas_reset_${service}_[a-f0-9]{12}$`));
  }
  const domainId = environment.EXCHANGE_DOMAIN_ID!;
  const seedId = environment.SIGNER_SEED_ID!;
  const ethereumChainId = environment.ETH_CHAIN_ID!;
  const solanaGenesisHash = environment.SOLANA_GENESIS_HASH!;
  const chainNetworks: ChainNetworkMap = {
    ethereum: { network: ethereumChainId, chainId: ethereumChainId },
    bitcoin: { network: 'regtest', rpcNetwork: 'regtest' },
    solana: { network: solanaGenesisHash, genesisHash: solanaGenesisHash },
  };
  const wallet = new WalletPrismaService({ databaseUrl: environment.WALLET_DATABASE_URL! });
  const user = new UserPrismaService({ databaseUrl: environment.USER_DATABASE_URL! });
  const ledger = new LedgerPrismaService({ databaseUrl: environment.LEDGER_DATABASE_URL! });
  let core: SigningCore | undefined;
  try {
    const custody = new CustodyService(
      wallet,
      { seedId, ethereumChainId, solanaGenesisHash, chainNetworks },
      { domainId, apiKey: undefined },
      { resetEpoch: context.plan.resetEpoch },
    );
    const bootstrap = await custody.bootstrap();
    assert.equal(bootstrap.hotWallets.length, 3);
    assert.equal(bootstrap.managementWallets.length, 2);
    assert.ok(bootstrap.hotWallets.every((row) => row.account === 0 && row.custody_role === 'hot'));
    assert.ok(
      bootstrap.managementWallets.every(
        (row) => row.account === 1 && row.management_purpose === 'gas_fee',
      ),
    );
    const replay = await custody.bootstrap();
    assert.deepEqual(
      replay.hotWallets.map((row) => row.id),
      bootstrap.hotWallets.map((row) => row.id),
    );
    assert.deepEqual(
      replay.managementWallets.map((row) => row.id),
      bootstrap.managementWallets.map((row) => row.id),
    );
    const customerId = randomUUID();
    await user.user.create({
      data: {
        id: customerId,
        email: `rehearsal-${customerId}@example.invalid`,
        password_hash: `scrypt$131072$8$1$${randomBytes(32).toString('hex')}$${randomBytes(64).toString('hex')}`,
      },
    });
    await wallet.exchangeCustomer.create({
      data: {
        customer_id: customerId,
        external_id: customerId,
        domain_id: domainId,
        reset_epoch: context.plan.resetEpoch,
      },
    });
    const customer = await wallet.$transaction((tx) =>
      custody.allocateCustomer(tx, customerId, 'ethereum', ethereumChainId),
    );
    assert.equal(customer.account, 10);
    const replayCustomer = await wallet.$transaction((tx) =>
      custody.allocateCustomer(tx, customerId, 'ethereum', ethereumChainId),
    );
    assert.equal(replayCustomer.id, customer.id);
    const bitcoin = await wallet.$transaction((tx) =>
      custody.allocateCustomer(tx, customerId, 'bitcoin', 'regtest'),
    );
    const solana = await wallet.$transaction((tx) =>
      custody.allocateCustomer(tx, customerId, 'solana', solanaGenesisHash),
    );
    assert.equal(bitcoin.account, 11);
    assert.equal(solana.account, 12);
    core = await SigningCore.fromFile(
      environment.SIGNER_SEED_FILE!,
      seedId,
      ethereumChainId,
      { ethereum: ethereumChainId },
      { domainId, chainNetworks },
    );
    const signing = new SigningService(core);
    const requests = await wallet.outbox.findMany({ where: { queue: QUEUES.signer } });
    assert.equal(requests.length, 8);
    for (const request of requests) {
      const command = walletDeriveSchema.parse(request.payload);
      const existing = await wallet.wallet.findUniqueOrThrow({ where: { id: command.walletId } });
      assert.equal(command.domainId, domainId);
      assert.equal(command.request.seedId, seedId);
      assert.equal(command.network, existing.network);
      assert.equal(command.path, existing.path);
      assert.equal(command.requestDigest, existing.derivation_request_digest);
      const derived = walletDerivedSchema.parse(signing.execute(command));
      assert.equal(derived.network, command.network);
      assert.equal(derived.path, command.path);
      assert.equal(derived.requestDigest, command.requestDigest);
      assert.equal(
        await canonicalizeDerivedAddress(command.request.chain, command.network, derived.address),
        derived.address,
      );
      // Fixture completion deliberately does not assert provider/registry readiness.
      await wallet.wallet.update({
        where: { id: existing.id },
        data: { address: derived.address, status: 'ready' },
      });
    }
    const hot = await wallet.wallet.findUniqueOrThrow({
      where: { id: bootstrap.hotWallets.find((row) => row.chain === 'ethereum')!.id },
    });
    const hotAddresses: Record<string, string> = {};
    for (const row of bootstrap.hotWallets) {
      const derived = await wallet.wallet.findUniqueOrThrow({ where: { id: row.id } });
      assert.ok(derived.address);
      hotAddresses[row.chain] = derived.address;
    }
    assert.ok(hot.address);
    const readyCustomer = await wallet.wallet.findUniqueOrThrow({ where: { id: customer.id } });
    assert.ok(readyCustomer.address);
    assert.notEqual(readyCustomer.address, hot.address);
    assert.equal(await ledger.journalBatch.count(), 0);
    assert.equal(await ledger.ledgerEntry.count(), 0);
    assert.equal(await ledger.ledgerAccount.count({ where: { owner_kind: 'customer' } }), 0);
    return {
      hotAddress: hot.address,
      hotAddresses,
      firstCustomerAccount: customer.account,
      customerLiabilityUnits: '0',
    };
  } finally {
    core?.close();
    await Promise.all([wallet.$disconnect(), user.$disconnect(), ledger.$disconnect()]);
  }
}
