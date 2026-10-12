import { KeyObject } from 'node:crypto';
import { SigningCore } from './signing.core.js';
import {
  TokenPreparation,
  validateTokenPreparation,
} from '../../../../packages/chain/src/token-planner.js';
import {
  TokenExecutionAuthorization,
  verifyTokenExecutionAuthorization,
} from '../../../../packages/shared/src/token-authorization.js';
import { executionDigest } from '../../../../packages/shared/src/execution-authorization.js';
import { tokenSignRequestSchema } from '../../../../packages/shared/src/token-contracts.js';

/** Independent token authority. Native execution/queue HMAC never grants token or management key access. */
export class TokenSigningPolicy {
  constructor(
    private readonly settings: {
      enabled: boolean;
      domainId: string;
      resetEpoch: string;
      authorityPublicKey?: KeyObject;
    },
    private readonly core: SigningCore,
  ) {
    if (
      settings.enabled &&
      (!settings.authorityPublicKey ||
        settings.authorityPublicKey.type !== 'public' ||
        settings.authorityPublicKey.asymmetricKeyType !== 'ed25519')
    )
      throw new Error('Token authority key must be public Ed25519');
  }

  authorize(
    prepared: TokenPreparation,
    authorization: TokenExecutionAuthorization,
    now = new Date(),
  ) {
    if (!this.settings.enabled || !this.settings.authorityPublicKey)
      throw new Error('Token execution disabled');
    const c = verifyTokenExecutionAuthorization(authorization, this.settings.authorityPublicKey);
    validateTokenPreparation(prepared);
    const r = tokenSignRequestSchema.parse(prepared.request),
      tx = r.transaction;
    if (
      c.domainId !== this.settings.domainId ||
      c.resetEpoch !== this.settings.resetEpoch ||
      c.seedId !== this.core.seedId ||
      c.preparationDigest !== prepared.preparedDigest ||
      c.requestHash !== executionDigest(r) ||
      executionDigest(c.certificate) !== prepared.certificateDigest ||
      c.expiresAt !== prepared.expiresAt ||
      prepared.fundingShortfallUnits !== '0'
    )
      throw new Error('Token authorization identity or prepared evidence mismatch');
    const expiry = Date.parse(c.expiresAt);
    if (expiry <= now.getTime() || expiry > now.getTime() + 300000)
      throw new Error('Token authorization expired');
    if (
      r.wallet.seedId !== c.seedId ||
      r.wallet.network !== this.core.network(r.wallet.chain) ||
      r.wallet.account !== c.source.account ||
      !this.same(r.wallet.chain, r.wallet.address, c.source.address)
    )
      throw new Error('Token source authority mismatch');
    const derive = (account: number, path: string, address: string) => {
      this.core.validateDerivation(c.domainId, r.wallet.network, path, {
        chain: r.wallet.chain,
        seedId: c.seedId,
        account,
      });
      const derived = this.core.derive({ chain: r.wallet.chain, seedId: c.seedId, account });
      if (!this.same(r.wallet.chain, derived.address, address))
        throw new Error('Token custody derivation mismatch');
    };
    derive(c.source.account, c.source.path, c.source.address);
    const recipient = tx.kind === 'erc20' ? tx.recipient : tx.recipientOwner;
    if (!this.same(r.wallet.chain, c.target.address, recipient))
      throw new Error('Token recipient mismatch');
    if (c.purpose === 'token_sweep') {
      if (
        c.target.domainId !== c.domainId ||
        c.target.seedId !== c.seedId ||
        c.target.walletId === c.source.walletId
      )
        throw new Error('Token sweep hot authority mismatch');
      derive(0, c.target.path, c.target.address);
    }
    if (tx.kind === 'erc20') {
      if (c.sponsor) throw new Error('Ethereum token gas must use the source');
    } else if (c.purpose === 'token_sweep') {
      if (
        !c.sponsor ||
        tx.feePayer.account !== 1 ||
        c.sponsor.walletId === c.source.walletId ||
        c.sponsor.walletId === c.target.walletId ||
        tx.feePayer.address !== c.sponsor.address
      )
        throw new Error('SPL sweep requires independently bound management1 sponsor');
      derive(1, c.sponsor.path, c.sponsor.address);
    } else if (c.sponsor || tx.feePayer.account !== 0 || tx.feePayer.address !== c.source.address)
      throw new Error('SPL withdrawals must pay fees from hot0');
  }

  async sign(prepared: TokenPreparation, authorization: TokenExecutionAuthorization) {
    this.authorize(prepared, authorization);
    return this.core.signToken(prepared.request);
  }

  private same(chain: string, a: string, b: string) {
    return chain === 'ethereum' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}
