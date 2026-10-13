import { createHash } from 'node:crypto';
import { canonical } from '../../../../packages/queue/src/messages.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import {
  ExchangeWatchProvider,
  ProviderBackfillRequest,
  ProviderInstallRequest,
  ProviderRemoveRequest,
  ProviderCertification,
  ProviderWatchIdentity,
  providerBackfillPageSchema,
  providerInstallAcknowledgmentSchema,
  providerRemoveAcknowledgmentSchema,
} from './provider.contracts.js';

export interface ExchangeProviderConfig {
  name: 'quicknode' | 'bitcoin-core';
  url?: string;
  apiKey?: string;
  certifications: ProviderCertification[];
  timeoutMs?: number;
  nativeTraceMode?: 'top-level' | 'callTracer';
  bitcoin?: {
    url?: string;
    apiKey?: string;
    certifications: ProviderCertification[];
  };
}

export class HttpExchangeWatchProvider implements ExchangeWatchProvider {
  readonly name: ExchangeProviderConfig['name'];
  private readonly base?: URL;
  constructor(
    private readonly config: ExchangeProviderConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.name = config.name;
    if (config.url) {
      const url = new URL(config.url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Provider gateway URL must use HTTPS or loopback HTTP without credentials/query',
        );
      this.base = url;
    }
  }

  certified(chain: string, network: string) {
    const providerSupportsChain =
      this.name === 'quicknode'
        ? chain === 'ethereum' || chain === 'solana'
        : chain === 'bitcoin' && network === 'regtest';
    return (
      !!this.base &&
      !!this.config.apiKey &&
      providerSupportsChain &&
      (chain !== 'ethereum' || this.config.nativeTraceMode === 'callTracer') &&
      this.config.certifications.some(
        (certificate) =>
          certificate.provider === this.name &&
          certificate.chain === chain &&
          certificate.network === network,
      )
    );
  }

  tokenCertified(chain: string, network: string) {
    return (
      this.certified(chain, network) &&
      this.config.certifications.some(
        (c) =>
          c.provider === this.name &&
          c.chain === chain &&
          c.network === network &&
          c.assetScope === 'native-and-transfer-tokens' &&
          c.tokenTransferCoverage &&
          c.tokenHistoryCoverage &&
          (chain !== 'solana' || c.ownedTokenAccountCoverage),
      )
    );
  }

  async install(request: ProviderInstallRequest) {
    return providerInstallAcknowledgmentSchema.parse(await this.call('install', request));
  }

  async backfill(request: ProviderBackfillRequest) {
    return providerBackfillPageSchema.parse(await this.call('backfill', request));
  }

  async remove(request: ProviderRemoveRequest) {
    return providerRemoveAcknowledgmentSchema.parse(await this.call('remove', request));
  }

  private async call(
    action: 'install' | 'backfill' | 'remove',
    request: ProviderInstallRequest | ProviderBackfillRequest | ProviderRemoveRequest,
  ) {
    if (!this.certified(request.chain, request.network) || request.provider !== this.name)
      throw new ActionRejectedError('Selected provider is not certified for this chain/network');
    const key = createHash('sha256').update(canonical({ action, request })).digest('hex');
    const response = await this.fetcher(
      new URL(`${this.base!.pathname.replace(/\/$/, '')}/v1/watches/${action}`, this.base),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
          'idempotency-key': key,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
      },
    );
    if (!response.ok)
      throw new Error(`Provider gateway ${action} failed with status ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 1024 * 1024) throw new Error('Provider response exceeds maximum size');
    const body = await response.text();
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error('Provider response exceeds maximum size');
    return JSON.parse(body) as unknown;
  }
}

// The public networks and private regtest adapter have independent credentials and certificates.
export class RoutingExchangeWatchProvider implements ExchangeWatchProvider {
  readonly name: ExchangeProviderConfig['name'];
  private readonly primary: HttpExchangeWatchProvider;
  private readonly bitcoin?: HttpExchangeWatchProvider;

  constructor(config: ExchangeProviderConfig, fetcher: typeof fetch = fetch) {
    this.name = config.name;
    this.primary = new HttpExchangeWatchProvider(config, fetcher);
    if (config.bitcoin)
      this.bitcoin = new HttpExchangeWatchProvider(
        { name: 'bitcoin-core', ...config.bitcoin },
        fetcher,
      );
  }

  providerFor(chain: string, network: string) {
    return this.route(chain, network)?.name;
  }

  certified(chain: string, network: string) {
    return this.route(chain, network)?.certified(chain, network) ?? false;
  }

  tokenCertified(chain: string, network: string) {
    return this.route(chain, network)?.tokenCertified(chain, network) ?? false;
  }

  async install(request: ProviderInstallRequest) {
    return this.forRequest(request).install(request);
  }

  async backfill(request: ProviderBackfillRequest) {
    return this.forRequest(request).backfill(request);
  }

  async remove(request: ProviderRemoveRequest) {
    return this.forRequest(request).remove(request);
  }

  private route(chain: string, network: string) {
    if (chain === 'bitcoin' && network === 'regtest')
      return this.bitcoin ?? (this.primary.name === 'bitcoin-core' ? this.primary : undefined);
    if (chain === 'ethereum' || chain === 'solana')
      return this.primary.name === 'quicknode' ? this.primary : undefined;
    return undefined;
  }

  private forRequest(request: ProviderWatchIdentity) {
    const provider = this.route(request.chain, request.network);
    if (!provider || provider.name !== request.provider)
      throw new ActionRejectedError(
        'Provider request does not match the selected chain/network route',
      );
    return provider;
  }
}
