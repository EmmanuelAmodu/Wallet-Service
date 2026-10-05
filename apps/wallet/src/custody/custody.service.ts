import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CustodyDomain, Prisma, Wallet, WalletCustodyRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { coreDerivationPath, getWalletCore } from '../../../../packages/chain/src/coin-metadata.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { postgresErrorCode } from '../../../../packages/database/src/postgres-error.js';
import {
  canonical,
  DerivationBinding,
  derivationRequestDigest,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { QueueConfig, queueConfig } from '../../../../packages/queue/src/queue.config.js';
import { Chain } from '../../../../packages/shared/src/contracts.js';
import { ExchangeApiSettings, exchangeApiConfig } from '../config/exchange-api.config.js';
import { WalletConfig, walletConfig } from '../config/wallet.config.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';

const POLICY_VERSION = 'exchange-financial-v1';
const SOLANA_DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROFILES = [
  {
    chain: 'ethereum',
    network: '11155111',
    decimals: 18,
    symbol: 'ETH',
    name: 'Sepolia Ether',
    minimumSweep: '1000000000000000',
    maximumFee: '5000000000000000',
    management: {
      operation: '5000000000000000',
      customer24h: '10000000000000000',
      domain24h: '50000000000000000',
    },
  },
  {
    chain: 'bitcoin',
    network: 'regtest',
    decimals: 8,
    symbol: 'BTC',
    name: 'Regtest Bitcoin',
    minimumSweep: '10000',
    maximumFee: '10000',
    management: undefined,
  },
  {
    chain: 'solana',
    network: SOLANA_DEVNET,
    decimals: 9,
    symbol: 'SOL',
    name: 'Devnet SOL',
    minimumSweep: '1000000',
    maximumFee: '100000',
    management: { operation: '10000000', customer24h: '20000000', domain24h: '100000000' },
  },
] as const;

@Injectable()
export class CustodyService {
  constructor(
    @Inject(WalletPrismaService) private readonly db: WalletPrismaService,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
    @Inject(exchangeApiConfig.KEY) private readonly exchange: ExchangeApiSettings,
    @Inject(queueConfig.KEY) private readonly queue: Pick<QueueConfig, 'resetEpoch'>,
  ) {}

  private domainId() {
    if (!this.exchange.domainId)
      throw new ServiceUnavailableException('EXCHANGE_DOMAIN_ID is required for custody issuance');
    return this.exchange.domainId;
  }

  validateNetwork(chain: Chain, network: string) {
    const profile = PROFILES.find((entry) => entry.chain === chain && entry.network === network);
    if (!profile)
      throw new BadRequestException(
        'Custody supports Sepolia, Bitcoin regtest and Solana Devnet only',
      );
    if (networkFor(chain, this.config) !== profile.network)
      throw new ConflictException(
        'Custody network differs from the configured signer/RPC identity',
      );
    return profile;
  }

  async configure(tx?: Prisma.TransactionClient): Promise<CustodyDomain> {
    if (!tx) return this.db.$transaction((db) => this.configure(db));
    const domainId = this.domainId();
    for (const profile of PROFILES) this.validateNetwork(profile.chain, profile.network);
    await lock(tx, `custody-domain:${domainId}`);
    const previous = await tx.custodyDomain.findUnique({ where: { id: domainId } });
    if (
      previous &&
      (previous.seed_id !== this.config.seedId ||
        previous.reset_epoch !== this.queue.resetEpoch ||
        previous.policy_version !== POLICY_VERSION ||
        previous.configuration_revision !== 1)
    )
      throw new ConflictException(
        'Custody domain seed, epoch and policy are immutable; use a new generation',
      );
    if (previous && previous.status !== 'active')
      throw new ConflictException('Custody domain is paused or retired');
    const domain =
      previous ??
      (await tx.custodyDomain.create({
        data: {
          id: domainId,
          seed_id: this.config.seedId,
          reset_epoch: this.queue.resetEpoch,
          policy_version: POLICY_VERSION,
          configuration_revision: 1,
        },
      }));
    for (const profile of PROFILES) {
      const identity = { domain_id: domainId, chain: profile.chain, network: profile.network };
      const nativeAsset = `token:${profile.chain}:native`;
      const network = await tx.custodyNetwork.findUnique({
        where: { domain_id_chain: { domain_id: domainId, chain: profile.chain } },
      });
      if (
        network &&
        (network.network !== profile.network ||
          network.native_asset_id !== nativeAsset ||
          network.configuration_revision !== 1)
      )
        throw new ConflictException('Custody network identity is immutable');
      if (network && !network.enabled) throw new ConflictException('Custody network is disabled');
      if (!network)
        await tx.custodyNetwork.create({ data: { ...identity, native_asset_id: nativeAsset } });
      const metadata = {
        ...identity,
        asset_id: nativeAsset,
        standard: 'native',
        decimals: profile.decimals,
        symbol: profile.symbol,
        name: profile.name,
        minimum_credit_units: '1',
        minimum_sweep_units: profile.minimumSweep,
        maximum_fee_units: profile.maximumFee,
        policy_version: POLICY_VERSION,
        configuration_revision: 1,
      };
      const asset = await tx.assetConfiguration.findUnique({
        where: { domain_id_chain_network_asset_id: { ...identity, asset_id: nativeAsset } },
      });
      if (
        asset &&
        Object.entries(metadata).some(([key, value]) => asset[key as keyof typeof asset] !== value)
      )
        throw new ConflictException(
          'Pinned native asset metadata differs from the custody profile',
        );
      if (!asset)
        await tx.assetConfiguration.create({
          data: { ...metadata, observation_enabled: true, credit_enabled: true },
        });
      if (profile.management) {
        const policy = {
          ...identity,
          account: 1,
          purpose: 'gas_fee',
          permitted_actions: ['funding', 'fee-sponsorship', 'account-setup'],
          maximum_operation_units: profile.management.operation,
          maximum_customer_24h_units: profile.management.customer24h,
          maximum_domain_24h_units: profile.management.domain24h,
          policy_version: POLICY_VERSION,
          configuration_revision: 1,
        };
        const existing = await tx.managementWalletPurpose.findUnique({
          where: { domain_id_chain_network_account: { ...identity, account: 1 } },
        });
        if (
          existing &&
          Object.entries(policy).some(
            ([key, value]) =>
              canonical(existing[key as keyof typeof existing]) !== canonical(value),
          )
        )
          throw new ConflictException('Management purpose policy differs from the custody profile');
        if (!existing) await tx.managementWalletPurpose.create({ data: policy });
      }
    }
    return domain;
  }

  async bootstrap(tx?: Prisma.TransactionClient): Promise<{
    domainId: string;
    resetEpoch: string;
    hotWallets: Wallet[];
    managementWallets: Wallet[];
  }> {
    // Initialize WASM before acquiring transaction locks on the normal bootstrap path.
    await getWalletCore();
    if (!tx) return this.db.$transaction((db) => this.bootstrap(db));
    const domain = await this.configure(tx);
    const hotWallets: Wallet[] = [];
    const managementWallets: Wallet[] = [];
    for (const profile of PROFILES) {
      hotWallets.push(await this.ensureWallet(tx, profile.chain, profile.network, 'hot', 0));
      if (profile.management)
        managementWallets.push(await this.createManagement(tx, profile.chain, profile.network, 1));
    }
    return { domainId: domain.id, resetEpoch: domain.reset_epoch, hotWallets, managementWallets };
  }

  async createManagement(tx: Prisma.TransactionClient, chain: Chain, network: string, account = 1) {
    this.validateNetwork(chain, network);
    await this.configure(tx);
    if (!Number.isInteger(account) || account < 1 || account > 9)
      throw new BadRequestException('Management accounts must be explicitly reserved in 1–9');
    const purpose = await tx.managementWalletPurpose.findUnique({
      where: {
        domain_id_chain_network_account: { domain_id: this.domainId(), chain, network, account },
      },
    });
    if (!purpose)
      throw new ConflictException('Management account has no approved purpose and spending policy');
    return this.ensureWallet(
      tx,
      chain,
      network,
      'management',
      account,
      undefined,
      undefined,
      purpose.purpose,
    );
  }

  async allocateCustomerAccount(tx: Prisma.TransactionClient) {
    try {
      const [row] = await tx.$queryRaw<
        { account: bigint }[]
      >`SELECT nextval('wallets_account_seq') AS account`;
      const account = Number(row?.account);
      if (!Number.isSafeInteger(account) || account < 10 || account > 2147483647)
        throw new ServiceUnavailableException(
          'Customer derivation account allocator is outside its supported range',
        );
      return account;
    } catch (error) {
      if (postgresErrorCode(error) === '2200H')
        throw new ServiceUnavailableException('Customer derivation account range is exhausted');
      throw error;
    }
  }

  async allocateCustomer(
    tx: Prisma.TransactionClient,
    customerId: string,
    chain: Chain,
    network: string,
  ) {
    this.validateNetwork(chain, network);
    await this.configure(tx);
    const domainId = this.domainId();
    await lock(tx, canonical(['custody-customer', domainId, customerId, chain, network]));
    const customer = await tx.exchangeCustomer.findUnique({ where: { customer_id: customerId } });
    if (
      !customer ||
      customer.domain_id !== domainId ||
      customer.reset_epoch !== this.queue.resetEpoch
    )
      throw new ConflictException(
        'Customer is not registered in the configured custody domain and epoch',
      );
    const hot = await tx.wallet.findFirst({
      where: {
        custody_domain_id: domainId,
        reset_epoch: this.queue.resetEpoch,
        chain,
        network,
        custody_role: 'hot',
        account: 0,
        active: true,
      },
    });
    if (!hot) throw new ConflictException('Hot0 custody bootstrap has not completed');
    const existing = await tx.wallet.findFirst({
      where: {
        custody_domain_id: domainId,
        customer_id: customerId,
        chain,
        network,
        custody_role: 'customer_deposit',
        active: true,
      },
    });
    if (existing) {
      await this.enqueueDerivation(tx, existing);
      return existing;
    }
    return this.ensureWallet(
      tx,
      chain,
      network,
      'customer_deposit',
      await this.allocateCustomerAccount(tx),
      customerId,
      hot.id,
    );
  }

  private async ensureWallet(
    tx: Prisma.TransactionClient,
    chain: Chain,
    network: string,
    role: WalletCustodyRole,
    account: number,
    customerId?: string,
    hotWalletId?: string,
    purpose?: string,
  ) {
    const domainId = this.domainId();
    await lock(tx, canonical(['custody-account', domainId, chain, network, account]));
    const existing = await tx.wallet.findFirst({
      where: { seed_id: this.config.seedId, chain, account },
    });
    if (existing) {
      if (
        existing.custody_domain_id !== domainId ||
        existing.reset_epoch !== this.queue.resetEpoch ||
        existing.network !== network ||
        existing.custody_role !== role ||
        !existing.active ||
        existing.customer_id !== (customerId ?? null) ||
        existing.hot_wallet_id !== (hotWalletId ?? null) ||
        existing.management_purpose !== (purpose ?? null)
      )
        throw new ConflictException(
          'Reserved custody account is already owned by another identity; development records require a guarded reset',
        );
      await this.enqueueDerivation(tx, existing);
      return existing;
    }
    const id = randomUUID();
    const requestId = randomUUID();
    const path = await coreDerivationPath(chain, account, network);
    const binding: Omit<DerivationBinding, 'requestDigest'> = {
      walletId: id,
      requestId,
      domainId,
      network,
      path,
      role,
      request: { seedId: this.config.seedId, chain, account },
    };
    const wallet = await tx.wallet.create({
      data: {
        id,
        external_id: customerId ?? `custody:${domainId}:${role}:${account}`,
        chain,
        network,
        seed_id: this.config.seedId,
        account,
        path,
        custody_domain_id: domainId,
        reset_epoch: this.queue.resetEpoch,
        custody_role: role,
        customer_id: customerId,
        hot_wallet_id: hotWalletId,
        management_purpose: purpose,
        configuration_revision: 1,
        derivation_request_id: requestId,
        derivation_request_digest: derivationRequestDigest(binding),
      },
    });
    await this.enqueueDerivation(tx, wallet);
    return wallet;
  }

  private async enqueueDerivation(tx: Prisma.TransactionClient, wallet: Wallet) {
    if (wallet.status !== 'deriving') return;
    if (
      !wallet.derivation_request_id ||
      !wallet.derivation_request_digest ||
      !wallet.custody_domain_id
    )
      throw new ConflictException('Custody wallet has no immutable derivation request');
    await enqueue(
      tx,
      QUEUES.signer,
      {
        type: 'wallet.derive',
        walletId: wallet.id,
        requestId: wallet.derivation_request_id,
        requestDigest: wallet.derivation_request_digest,
        domainId: wallet.custody_domain_id,
        network: wallet.network,
        path: wallet.path,
        role: wallet.custody_role,
        request: { seedId: wallet.seed_id, chain: wallet.chain as Chain, account: wallet.account },
      },
      `derive-${wallet.derivation_request_id}`,
    );
  }

  async publicationAllowed(tx: Prisma.TransactionClient, wallet: Wallet) {
    if (
      !wallet.active ||
      wallet.custody_role === 'legacy' ||
      wallet.custody_domain_id !== this.domainId() ||
      wallet.reset_epoch !== this.queue.resetEpoch ||
      wallet.seed_id !== this.config.seedId
    )
      return false;
    try {
      this.validateNetwork(wallet.chain as Chain, wallet.network);
    } catch {
      return false;
    }
    const domain = await tx.custodyDomain.findUnique({ where: { id: this.domainId() } });
    const network = await tx.custodyNetwork.findUnique({
      where: {
        domain_id_chain: {
          domain_id: this.domainId(),
          chain: wallet.chain,
        },
      },
    });
    if (
      !domain ||
      domain.status !== 'active' ||
      domain.seed_id !== this.config.seedId ||
      domain.reset_epoch !== this.queue.resetEpoch ||
      domain.policy_version !== POLICY_VERSION ||
      domain.configuration_revision !== wallet.configuration_revision ||
      !network?.enabled ||
      network.network !== wallet.network ||
      network.configuration_revision !== wallet.configuration_revision
    )
      return false;
    const asset = await tx.assetConfiguration.findUnique({
      where: {
        domain_id_chain_network_asset_id: {
          domain_id: this.domainId(),
          chain: wallet.chain,
          network: wallet.network,
          asset_id: network.native_asset_id,
        },
      },
    });
    const profile = PROFILES.find(
      (entry) => entry.chain === wallet.chain && entry.network === wallet.network,
    )!;
    return (
      !!asset?.observation_enabled &&
      !!asset.credit_enabled &&
      asset.policy_version === domain.policy_version &&
      asset.configuration_revision === wallet.configuration_revision &&
      asset.standard === 'native' &&
      asset.decimals === profile.decimals &&
      asset.symbol === profile.symbol &&
      asset.name === profile.name &&
      asset.minimum_credit_units === '1' &&
      asset.minimum_sweep_units === profile.minimumSweep &&
      asset.maximum_fee_units === profile.maximumFee
    );
  }

  async markPublished(tx: Prisma.TransactionClient, walletId: string, revision: number) {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (!(await this.publicationAllowed(tx, wallet)))
      throw new ConflictException('Wallet is not an active configured custody identity');
    if (
      wallet.status !== 'ready' ||
      !wallet.address ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      revision < wallet.registry_revision
    )
      throw new ConflictException(
        'Published custody requires a valid derived address and monotonic registry revision',
      );
    return tx.wallet.update({
      where: { id: walletId },
      data: {
        registry_revision: revision,
        published_at: wallet.published_at ?? new Date(),
      },
    });
  }
}
