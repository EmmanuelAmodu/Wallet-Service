import { createPublicKey, KeyObject } from 'node:crypto';
import { SignRequest } from '../../../../packages/shared/src/contracts.js';
import { CustodySignAction } from '../../../../packages/shared/src/execution-contracts.js';
import {
  executionRequestDigest,
  verifyExecutionAuthorization,
} from '../../../../packages/shared/src/execution-authorization.js';
import { SigningCore } from './signing.core.js';

export type CustodySigningSettings = {
  enabled: boolean;
  domainId: string;
  resetEpoch: string;
  authorityPublicKey?: KeyObject;
  attestationPrivateKey?: KeyObject;
};

/** Independent from the queue HMAC. Only Wallet's scoped execution authority may authorize custody keys. */
export class CustodySigningPolicy {
  constructor(
    readonly settings: CustodySigningSettings,
    private readonly core: SigningCore,
  ) {
    if (settings.enabled && (!settings.authorityPublicKey || !settings.attestationPrivateKey))
      throw new Error('Native execution requires independent authority and signer keys');
    if (
      settings.enabled &&
      (settings.authorityPublicKey?.type !== 'public' ||
        settings.authorityPublicKey.asymmetricKeyType !== 'ed25519' ||
        settings.attestationPrivateKey?.type !== 'private' ||
        settings.attestationPrivateKey.asymmetricKeyType !== 'ed25519')
    )
      throw new Error('Execution keys have invalid type or ownership');
    if (
      settings.enabled &&
      settings.authorityPublicKey &&
      settings.attestationPrivateKey &&
      settings.authorityPublicKey
        .export({ type: 'spki', format: 'der' })
        .equals(
          createPublicKey(settings.attestationPrivateKey).export({ type: 'spki', format: 'der' }),
        )
    )
      throw new Error('Execution authority and signer keys must be separate');
  }

  authorize(action: CustodySignAction, now = new Date()): void {
    if (!this.settings.enabled || !this.settings.authorityPublicKey)
      throw new Error('Native sweep execution is disabled');
    const c = verifyExecutionAuthorization(action.authorization, this.settings.authorityPublicKey);
    const r = action.request;
    if (
      c.domainId !== this.settings.domainId ||
      c.resetEpoch !== this.settings.resetEpoch ||
      c.seedId !== this.core.seedId ||
      c.target.domainId !== c.domainId ||
      c.target.seedId !== c.seedId
    )
      throw new Error('Execution custody identity mismatch');
    if (
      c.operationId !== action.operationId ||
      c.attemptId !== action.attemptId ||
      c.requestDigest !== action.requestDigest ||
      c.preparationDigest !== action.preparationDigest
    )
      throw new Error('Execution attempt binding mismatch');
    const requestHash = executionRequestDigest(r);
    if (c.requestHash !== requestHash || c.preparationDigest !== requestHash)
      throw new Error('Execution prepared request mismatch');
    const expiry = Date.parse(c.expiresAt);
    if (expiry <= now.getTime() || expiry > now.getTime() + 300_000)
      throw new Error('Execution authorization expired or outside validity window');
    if (
      c.asset.chain !== r.wallet.chain ||
      c.asset.chain !== r.transaction.chain ||
      c.asset.network !== this.core.network(r.wallet.chain) ||
      r.wallet.network !== c.asset.network
    )
      throw new Error('Execution network mismatch');
    const approvedNetwork = {
      ethereum: '11155111',
      bitcoin: 'regtest',
      solana: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    }[c.asset.chain];
    if (c.asset.network !== approvedNetwork)
      throw new Error('Native execution network is not certified by this policy');
    if (
      r.wallet.seedId !== c.seedId ||
      r.wallet.account !== c.source.account ||
      !this.sameAddress(c.asset.chain, r.wallet.address, c.source.address)
    )
      throw new Error('Execution source mismatch');
    this.core.validateDerivation(c.domainId, c.asset.network, c.source.path, {
      seedId: c.seedId,
      chain: c.asset.chain,
      account: c.source.account,
    });
    this.core.validateDerivation(c.domainId, c.asset.network, c.target.path, {
      seedId: c.seedId,
      chain: c.asset.chain,
      account: 0,
    });
    const source = this.core.derive({
      seedId: c.seedId,
      chain: c.asset.chain,
      account: c.source.account,
    });
    const target = this.core.derive({ seedId: c.seedId, chain: c.asset.chain, account: 0 });
    if (
      c.source.walletId === c.target.walletId ||
      !this.sameAddress(c.asset.chain, source.address, c.source.address) ||
      !this.sameAddress(c.asset.chain, target.address, c.target.address)
    )
      throw new Error('Execution destination is not the configured hot derivation');
    const principal = BigInt(c.principalUnits),
      fee = BigInt(c.maxFeeUnits);
    const minimum = { ethereum: 1_000_000_000_000_000n, bitcoin: 10_000n, solana: 1_000_000n }[
      c.asset.chain
    ];
    const feeCap = { ethereum: 5_000_000_000_000_000n, bitcoin: 10_000n, solana: 100_000n }[
      c.asset.chain
    ];
    if (principal < minimum || fee > feeCap || fee * 100n > principal)
      throw new Error('Execution exceeds native sweep economics');
    this.validateOutputs(r, c.target.address, principal, fee);
  }

  private sameAddress(chain: string, a: string, b: string): boolean {
    return chain === 'ethereum' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private validateOutputs(
    r: SignRequest,
    hotAddress: string,
    principal: bigint,
    maxFee: bigint,
  ): void {
    const tx = r.transaction;
    if (tx.chain === 'ethereum') {
      if (
        !this.sameAddress(tx.chain, tx.to, hotAddress) ||
        BigInt(tx.amount) !== principal ||
        BigInt(tx.chainId) !== 11155111n ||
        BigInt(tx.gasLimit) < 21000n ||
        BigInt(tx.gasLimit) > 100000n ||
        BigInt(tx.maxFeePerGas) > 100_000_000_000n ||
        BigInt(tx.maxPriorityFeePerGas) > 2_000_000_000n ||
        BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas) ||
        BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) > maxFee
      )
        throw new Error('Ethereum native sweep policy rejected');
      return;
    }
    if (tx.chain === 'bitcoin') {
      if (
        tx.sweepAll !== true ||
        tx.outputs.length !== 1 ||
        tx.outputs[0].address !== hotAddress ||
        BigInt(tx.outputs[0].amount) !== principal ||
        tx.satsPerVbyte > 50 ||
        tx.utxos.length > 100
      )
        throw new Error('Bitcoin native sweep policy rejected');
      const total = tx.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n),
        fee = total - principal;
      if (fee <= 0n || fee > maxFee) throw new Error('Bitcoin native sweep fee policy rejected');
      return;
    }
    if (tx.chain === 'solana') {
      if (
        tx.outputs.length !== 1 ||
        tx.outputs[0].address !== hotAddress ||
        BigInt(tx.outputs[0].amount) !== principal ||
        maxFee < 5000n
      )
        throw new Error('Solana native sweep policy rejected');
      return;
    }
    throw new Error('Unapproved native sweep chain');
  }
}
