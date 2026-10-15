import {
  BitcoinBatchSignAction,
  bitcoinBatchSignSchema,
  validateBitcoinBatch,
  verifyBitcoinBatchAuthorization,
} from '../../../../packages/shared/src/bitcoin-batch-contracts.js';
import { CustodySigningSettings } from './custody-signing.policy.js';
import { SigningCore } from './signing.core.js';

/** Explicit batch claims are separate from single-obligation native authority. */
export class BitcoinBatchSigningPolicy {
  constructor(
    private readonly settings: CustodySigningSettings,
    private readonly core: SigningCore,
  ) {}

  authorize(input: BitcoinBatchSignAction, now = new Date()) {
    if (
      !this.settings.enabled ||
      !this.settings.withdrawalsEnabled ||
      !this.settings.bitcoinBatchesEnabled ||
      !this.settings.authorityPublicKey
    )
      throw new Error('Bitcoin batch signing is disabled');
    const action = bitcoinBatchSignSchema.parse(input);
    const claims = verifyBitcoinBatchAuthorization(
      action.authorization,
      this.settings.authorityPublicKey,
    );
    const { manifest, preparation } = validateBitcoinBatch(action.manifest, action.preparation);
    const expiry = Date.parse(claims.expiresAt);
    if (
      claims.domainId !== this.settings.domainId ||
      claims.resetEpoch !== this.settings.resetEpoch ||
      claims.seedId !== this.core.seedId ||
      claims.batchId !== action.batchId ||
      claims.batchId !== manifest.batchId ||
      claims.transactionId !== action.transactionId ||
      claims.domainId !== manifest.domainId ||
      claims.resetEpoch !== manifest.resetEpoch ||
      claims.seedId !== manifest.seedId ||
      claims.manifestDigest !== preparation.manifestDigest ||
      claims.preparationDigest !== preparation.preparationDigest ||
      claims.expiresAt !== preparation.expiresAt ||
      expiry <= now.getTime() ||
      expiry > now.getTime() + 300000 ||
      this.core.network('bitcoin') !== 'regtest'
    )
      throw new Error('Bitcoin batch authority identity or validity mismatch');
    this.core.validateDerivation(claims.domainId, 'regtest', claims.sourcePath, {
      chain: 'bitcoin',
      seedId: claims.seedId,
      account: 0,
    });
    const derived = this.core.derive({ chain: 'bitcoin', seedId: claims.seedId, account: 0 });
    if (derived.path !== claims.sourcePath || derived.address !== manifest.sourceAddress)
      throw new Error('Bitcoin batch hot source derivation mismatch');
    return preparation.request;
  }
}
