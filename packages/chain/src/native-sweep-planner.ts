import { BadGatewayException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TW } from '@trustwallet/wallet-core';
import { z } from 'zod';
import {
  BitcoinChain,
  EvmChain,
  SignRequest,
  SignedTransaction,
} from '../../shared/src/contracts.js';
import { ChainRpcService, RpcFailure } from './chain-rpc.service.js';
import { getWalletCore } from './coin-metadata.js';
import { regtestWitnessAddress } from './bitcoin-address.js';

export type NativeSweepChain = 'ethereum' | 'bitcoin' | 'solana';
export interface NativeSweepPlan {
  request: SignRequest['transaction'];
  amount: string;
  maxFeeUnits: string;
  resourceKeys: string[];
  expiresAt: string;
  lastValidBlockHeight?: number;
}
export interface NativeSweepObservation {
  state: 'pending' | 'confirmed' | 'failed' | 'reverted';
  blockHash?: string;
  blockHeight?: string;
  actualFeeUnits?: string;
}
export interface NativeSweepObservationInput {
  chain: NativeSweepChain;
  network: string;
  hash: string;
  request: SignRequest;
  signed: SignedTransaction;
  priorInclusion?: { blockHash: string; blockHeight: string };
}
export type SweepDeferralCode =
  'dust' | 'insufficient_balance' | 'fee_budget' | 'unavailable' | 'attention';
export class SweepDeferral extends Error {
  constructor(
    readonly code: SweepDeferralCode,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'SweepDeferral';
  }
}
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SYSTEM = '11111111111111111111111111111111';
const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const hexHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const btcHash = z.string().regex(/^[0-9a-f]{64}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
type EvmRequest = Extract<SignRequest['transaction'], { chain: EvmChain }>;
type BitcoinRequest = Extract<SignRequest['transaction'], { chain: BitcoinChain }>;
type SolanaRequest = Extract<SignRequest['transaction'], { chain: 'solana' }>;

function defer(code: SweepDeferralCode, reason: string): never {
  throw new SweepDeferral(code, reason);
}

function evidence(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new BadGatewayException(`Sweep RPC evidence mismatch: ${reason}`);
}

function budget(amount: bigint, fee: bigint, minimum: bigint, cap: bigint) {
  if (amount <= 0n) defer('insufficient_balance', 'Balance does not cover the fee reserve');
  if (amount < minimum) defer('dust', 'Spendable sweep amount is below the minimum');
  if (fee > cap || fee * 100n > amount)
    defer('fee_budget', 'Sweep fee exceeds the fixed or one percent fee budget');
}

function expires() {
  return new Date(Date.now() + 120_000).toISOString();
}

// JSON decimal values are interpreted exactly as their shortest decimal spelling.
// Reject values which require rounding rather than silently manufacturing satoshis.
export function bitcoinDecimalUnits(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new BadGatewayException('Bitcoin amount is not an exact decimal');
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0))
    throw new BadGatewayException('Bitcoin amount is not an exact decimal');
  const input = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!match) throw new BadGatewayException('Bitcoin amount is not an exact decimal');
  const scale = 8 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 100)
    throw new BadGatewayException('Bitcoin decimal exponent is out of range');
  let units = BigInt(match[1] + (match[2] ?? ''));
  if (scale >= 0) units *= 10n ** BigInt(scale);
  else {
    const divisor = 10n ** BigInt(-scale);
    if (units % divisor !== 0n)
      throw new BadGatewayException('Bitcoin amount loses satoshi precision');
    units /= divisor;
  }
  if (units > 2_100_000_000_000_000n)
    throw new BadGatewayException('Bitcoin amount exceeds the supply bound');
  return units;
}

/** Exact legacy System Program message used by the native Solana signer. */
export async function nativeSolanaMessage(
  source: string,
  destination: string,
  blockhash: string,
  amount: bigint,
): Promise<Buffer> {
  const core = await getWalletCore();
  const decode = (address: string) => {
    const bytes = Buffer.from(core.Base58.decodeNoCheck(address));
    if (bytes.length !== 32) throw new BadGatewayException('Invalid Solana public key');
    return bytes;
  };
  evidence(source !== destination && destination !== SYSTEM, 'invalid Solana sweep destination');
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2);
  data.writeBigUInt64LE(amount, 4);
  return Buffer.concat([
    Buffer.from([1, 0, 1, 3]),
    decode(source),
    decode(destination),
    decode(SYSTEM),
    decode(blockhash),
    Buffer.from([1, 2, 2, 0, 1, 12]),
    data,
  ]);
}

@Injectable()
export class NativeSweepPlanner {
  constructor(private readonly rpc: ChainRpcService) {}

  private async verify(chain: NativeSweepChain, network: string) {
    const approved = chain === 'ethereum' ? '11155111' : chain === 'bitcoin' ? 'regtest' : DEVNET;
    if (network !== approved || this.rpc.networkIdentity(chain) !== network)
      defer('attention', 'Native sweeps are restricted to the pinned development network');
    await this.rpc.verifyNetwork(chain);
  }

  async plan(input: {
    chain: NativeSweepChain;
    network: string;
    sourceAddress: string;
    hotAddress: string;
  }): Promise<NativeSweepPlan> {
    try {
      await this.verify(input.chain, input.network);
      if (input.sourceAddress === input.hotAddress)
        defer('attention', 'Sweep source and hot wallet must differ');
      if (input.chain === 'ethereum') return await this.ethereum(input);
      if (input.chain === 'bitcoin') return await this.bitcoin(input);
      return await this.solana(input);
    } catch (error) {
      if (error instanceof RpcFailure)
        defer('unavailable', 'Canonical RPC is unavailable; retry planning without signing');
      throw error;
    }
  }

  private async ethereum(input: { sourceAddress: string; hotAddress: string }) {
    const source = z
      .string()
      .regex(/^0x[0-9a-f]{40}$/)
      .parse(input.sourceAddress);
    const hot = z
      .string()
      .regex(/^0x[0-9a-f]{40}$/)
      .parse(input.hotAddress);
    const [finalizedRaw, pendingRaw, latestNonceRaw, pendingNonceRaw, blockRaw, priorityRaw, code] =
      await Promise.all([
        this.rpc.call('ethereum', 'eth_getBalance', [source, 'finalized']),
        this.rpc.call('ethereum', 'eth_getBalance', [source, 'pending']),
        this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'latest']),
        this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'pending']),
        this.rpc.call('ethereum', 'eth_getBlockByNumber', ['latest', false]),
        this.rpc.call('ethereum', 'eth_maxPriorityFeePerGas', []),
        this.rpc.call('ethereum', 'eth_getCode', [hot, 'finalized']),
      ]);
    if (code !== '0x') defer('attention', 'Native hot wallet must be an externally owned account');
    const latestNonce = BigInt(hexQuantity.parse(latestNonceRaw));
    const pendingNonce = BigInt(hexQuantity.parse(pendingNonceRaw));
    if (latestNonce !== pendingNonce)
      defer('attention', 'Untracked pending transactions occupy the source nonce');
    const finalized = BigInt(hexQuantity.parse(finalizedRaw));
    const pending = BigInt(hexQuantity.parse(pendingRaw));
    const balance = finalized < pending ? finalized : pending;
    const baseFee = BigInt(z.object({ baseFeePerGas: hexQuantity }).parse(blockRaw).baseFeePerGas);
    const quotedPriority = BigInt(hexQuantity.parse(priorityRaw));
    const priority = quotedPriority === 0n ? 1n : quotedPriority;
    const maxFee = baseFee * 2n + priority;
    if (priority > 2_000_000_000n || maxFee > 100_000_000_000n)
      defer('fee_budget', 'Ethereum fee estimate exceeds the pinned gas price budget');
    const estimate = async (amount: bigint) =>
      BigInt(
        hexQuantity.parse(
          await this.rpc.call('ethereum', 'eth_estimateGas', [
            {
              from: source,
              to: hot,
              value: `0x${amount.toString(16)}`,
              maxFeePerGas: `0x${maxFee.toString(16)}`,
              maxPriorityFeePerGas: `0x${priority.toString(16)}`,
            },
          ]),
        ),
      );
    if (balance === 0n) defer('insufficient_balance', 'No finalized native balance is spendable');
    let gas = ((await estimate(1n)) * 120n + 99n) / 100n;
    let fee = gas * maxFee;
    let amount = balance - fee;
    budget(amount, fee, 1_000_000_000_000_000n, 5_000_000_000_000_000n);
    const exactGas = ((await estimate(amount)) * 120n + 99n) / 100n;
    if (exactGas > gas) {
      gas = exactGas;
      fee = gas * maxFee;
      amount = balance - fee;
      budget(amount, fee, 1_000_000_000_000_000n, 5_000_000_000_000_000n);
    }
    const request: SignRequest['transaction'] = {
      chain: 'ethereum',
      chainId: '11155111',
      nonce: latestNonce.toString(),
      to: hot,
      amount: amount.toString(),
      gasLimit: gas.toString(),
      maxFeePerGas: maxFee.toString(),
      maxPriorityFeePerGas: priority.toString(),
    };
    return {
      request,
      amount: amount.toString(),
      maxFeeUnits: fee.toString(),
      resourceKeys: [`nonce:${source}:${latestNonce}`],
      expiresAt: expires(),
    };
  }

  private async bitcoin(input: { sourceAddress: string; hotAddress: string }) {
    const source = regtestWitnessAddress(input.sourceAddress);
    const hot = regtestWitnessAddress(input.hotAddress);
    if (source.program.length !== 20 || hot.program.length !== 20)
      defer('attention', 'Native Bitcoin custody requires P2WPKH addresses');
    evidence(
      source.address === input.sourceAddress && hot.address === input.hotAddress,
      'noncanonical address',
    );
    const ownScript = `0014${Buffer.from(source.program).toString('hex')}`;
    const candidates = z
      .array(
        z.object({
          txid: btcHash,
          vout: safeInteger.max(0xffffffff),
          address: z.string(),
          confirmations: safeInteger,
        }),
      )
      .parse(
        await this.rpc.call('bitcoin', 'listunspent', [6, 9_999_999, [source.address], false]),
      );
    const seen = new Set<string>();
    const available: BitcoinRequest['utxos'] = [];
    for (const candidate of [...candidates].sort((a, b) =>
      `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`),
    )) {
      const key = `${candidate.txid}:${candidate.vout}`;
      evidence(!seen.has(key), 'duplicate watch-only outpoint');
      seen.add(key);
      evidence(candidate.address === source.address, 'watch-only address filter was ignored');
      const raw = await this.rpc.call('bitcoin', 'gettxout', [
        candidate.txid,
        candidate.vout,
        true,
      ]);
      if (raw === null) continue; // A mempool spend won the race; never reserve it.
      const output = z
        .object({
          value: z.union([z.number(), z.string()]),
          confirmations: safeInteger,
          coinbase: z.boolean(),
          scriptPubKey: z.object({ hex: z.string(), address: z.string().optional() }),
        })
        .parse(raw);
      evidence(output.scriptPubKey.hex === ownScript, 'outpoint script is not owned by source');
      if (output.scriptPubKey.address)
        evidence(
          output.scriptPubKey.address === source.address,
          'outpoint address is not owned by source',
        );
      if (output.confirmations < 6 || (output.coinbase && output.confirmations < 100)) continue;
      const amount = bitcoinDecimalUnits(output.value);
      if (amount > 0n)
        available.push({
          txid: candidate.txid,
          vout: candidate.vout,
          amount: amount.toString(),
          script: ownScript,
        });
    }
    const utxos = available.slice(0, 100);
    if (!utxos.length) defer('insufficient_balance', 'No mature unspent outputs are available');
    const estimate = z
      .object({
        feerate: z.union([z.number(), z.string()]).optional(),
        errors: z.array(z.string()).optional(),
      })
      .parse(await this.rpc.call('bitcoin', 'estimatesmartfee', [6, 'CONSERVATIVE']));
    if (
      estimate.feerate === undefined &&
      (!estimate.errors?.length ||
        !estimate.errors.every((error) => /insufficient|not enough|no feerate found/i.test(error)))
    )
      defer('unavailable', 'Bitcoin fee estimate is missing without a no-data explanation');
    const feePerKb =
      estimate.feerate === undefined ? 2_000n : bitcoinDecimalUnits(estimate.feerate);
    const satsPerVbyte = (feePerKb + 999n) / 1000n;
    if (satsPerVbyte < 1n || satsPerVbyte > 100n)
      defer('fee_budget', 'Bitcoin fee estimate exceeds the pinned rate budget');
    const core = await getWalletCore();
    const proto = TW.Bitcoin.Proto;
    const total = utxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
    const unsigned = proto.SigningInput.fromObject({
      coinType: core.CoinType.bitcoin.value,
      hashType: core.BitcoinScript.hashTypeForCoin(core.CoinType.bitcoin),
      amount: total.toString(),
      toAddress: hot.signingAddress,
      changeAddress: source.signingAddress,
      byteFee: satsPerVbyte.toString(),
      useMaxUtxo: true,
      useMaxAmount: true,
      utxo: utxos.map((utxo) => ({
        amount: utxo.amount,
        script: Buffer.from(utxo.script, 'hex'),
        outPoint: {
          hash: Buffer.from(utxo.txid, 'hex').reverse(),
          index: utxo.vout,
          sequence: 0xffffffff,
        },
      })),
    });
    const plan = proto.TransactionPlan.decode(
      core.AnySigner.plan(proto.SigningInput.encode(unsigned).finish(), core.CoinType.bitcoin),
    );
    if (plan.error !== 0) defer('insufficient_balance', 'Bitcoin inputs cannot fund the sweep');
    const amount = BigInt(plan.amount.toString());
    const fee = BigInt(plan.fee.toString());
    evidence(
      amount + fee === total &&
        BigInt(plan.change.toString()) === 0n &&
        plan.utxos.length === utxos.length,
      'Wallet Core sweep plan does not consume the exact input set',
    );
    budget(amount, fee, 10_000n, 10_000n);
    const request: SignRequest['transaction'] = {
      chain: 'bitcoin',
      outputs: [{ address: hot.address, amount: amount.toString() }],
      utxos,
      satsPerVbyte: Number(satsPerVbyte),
      sweepAll: true,
    };
    return {
      request,
      amount: amount.toString(),
      maxFeeUnits: fee.toString(),
      resourceKeys: utxos.map((utxo) => `utxo:${utxo.txid}:${utxo.vout}`),
      expiresAt: expires(),
    };
  }

  private async solana(input: { sourceAddress: string; hotAddress: string }) {
    const [balanceRaw, accountRaw, blockhashRaw] = await Promise.all([
      this.rpc.call('solana', 'getBalance', [input.sourceAddress, { commitment: 'finalized' }]),
      this.rpc.call('solana', 'getAccountInfo', [
        input.sourceAddress,
        { commitment: 'finalized', encoding: 'base64' },
      ]),
      this.rpc.call('solana', 'getLatestBlockhash', [{ commitment: 'finalized' }]),
    ]);
    const balance = z
      .object({ context: z.object({ slot: safeInteger }), value: safeInteger })
      .parse(balanceRaw);
    const account = z
      .object({
        context: z.object({ slot: safeInteger }),
        value: z
          .object({
            owner: z.string(),
            executable: z.boolean(),
            lamports: safeInteger,
            data: z.tuple([z.string(), z.literal('base64')]),
          })
          .nullable(),
      })
      .parse(accountRaw);
    if (!account.value) defer('insufficient_balance', 'No finalized native account is present');
    if (account.value.owner !== SYSTEM || account.value.executable)
      defer('attention', 'Source is not an ordinary System Program account');
    const length = Buffer.from(account.value.data[0], 'base64').length;
    if (length !== 0)
      defer('attention', 'Data-bearing System accounts require a separate spending policy');
    const rent = BigInt(
      safeInteger.parse(
        await this.rpc.call('solana', 'getMinimumBalanceForRentExemption', [
          length,
          { commitment: 'finalized' },
        ]),
      ),
    );
    if (rent > 5_000_000n) defer('fee_budget', 'Solana rent reserve exceeds the pinned budget');
    const blockhash = z
      .object({
        context: z.object({ slot: safeInteger }),
        value: z.object({ blockhash: z.string(), lastValidBlockHeight: safeInteger.positive() }),
      })
      .parse(blockhashRaw);
    const available = BigInt(Math.min(balance.value, account.value.lamports));
    const provisional = available - rent;
    if (provisional <= 0n)
      defer('insufficient_balance', 'Finalized balance does not cover retained rent');
    const floor = Math.max(balance.context.slot, account.context.slot, blockhash.context.slot);
    const feeFor = async (amount: bigint) => {
      const message = await nativeSolanaMessage(
        input.sourceAddress,
        input.hotAddress,
        blockhash.value.blockhash,
        amount,
      );
      const result = z
        .object({ context: z.object({ slot: safeInteger }), value: safeInteger.nullable() })
        .parse(
          await this.rpc.call('solana', 'getFeeForMessage', [
            message.toString('base64'),
            { commitment: 'finalized', minContextSlot: floor },
          ]),
        );
      if (result.context.slot < floor || result.value === null)
        defer('unavailable', 'Solana fee quote is unavailable for the pinned message context');
      return BigInt(result.value);
    };
    const fee = await feeFor(provisional);
    const amount = available - rent - fee;
    budget(amount, fee, 1_000_000n, 100_000n);
    if ((await feeFor(amount)) !== fee)
      defer('unavailable', 'Solana fee changed for the exact sweep message');
    const currentHeight = safeInteger.parse(
      await this.rpc.call('solana', 'getBlockHeight', [
        { commitment: 'finalized', minContextSlot: floor },
      ]),
    );
    if (currentHeight >= blockhash.value.lastValidBlockHeight)
      defer('unavailable', 'Solana blockhash validity elapsed during planning');
    const request: SignRequest['transaction'] = {
      chain: 'solana',
      outputs: [{ address: input.hotAddress, amount: amount.toString() }],
      recentBlockhash: blockhash.value.blockhash,
      lastValidBlockHeight: blockhash.value.lastValidBlockHeight,
    };
    return {
      request,
      amount: amount.toString(),
      maxFeeUnits: fee.toString(),
      resourceKeys: [`balance:${input.sourceAddress}`],
      expiresAt: expires(),
      lastValidBlockHeight: blockhash.value.lastValidBlockHeight,
    };
  }

  async observe(input: NativeSweepObservationInput): Promise<NativeSweepObservation> {
    await this.verify(input.chain, input.network);
    evidence(
      input.request.wallet.chain === input.chain &&
        input.request.transaction.chain === input.chain &&
        input.request.wallet.network === input.network,
      'prepared request identity',
    );
    evidence(input.hash === input.signed.txHash, 'signed transaction hash');
    if (input.priorInclusion) {
      const height = BigInt(
        z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .parse(input.priorInclusion.blockHeight),
      );
      let blockHash: string;
      if (input.chain === 'ethereum') {
        const block = await this.rpc.call('ethereum', 'eth_getBlockByNumber', [
          `0x${height.toString(16)}`,
          false,
        ]);
        if (block === null)
          throw new BadGatewayException('Prior canonical Ethereum block unavailable');
        const parsed = z.object({ hash: hexHash, number: hexQuantity }).parse(block);
        evidence(BigInt(parsed.number) === height, 'prior Ethereum inclusion height');
        blockHash = parsed.hash;
      } else {
        evidence(
          height <= BigInt(Number.MAX_SAFE_INTEGER),
          'prior inclusion height exceeds RPC range',
        );
        if (input.chain === 'bitcoin')
          blockHash = btcHash.parse(
            await this.rpc.call('bitcoin', 'getblockhash', [Number(height)]),
          );
        else {
          const block = await this.rpc.call('solana', 'getBlock', [
            Number(height),
            {
              commitment: 'finalized',
              transactionDetails: 'none',
              rewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ]);
          if (block === null)
            throw new BadGatewayException('Prior canonical Solana block unavailable');
          blockHash = z.object({ blockhash: z.string().min(32).max(44) }).parse(block).blockhash;
        }
      }
      if (blockHash !== input.priorInclusion.blockHash) return { state: 'reverted' };
    }
    if (input.chain === 'ethereum') return this.observeEthereum(input);
    if (input.chain === 'bitcoin') return this.observeBitcoin(input);
    return this.observeSolana(input);
  }

  private async observeEthereum(input: {
    hash: string;
    request: SignRequest;
    signed: SignedTransaction;
  }) {
    const request = input.request.transaction as EvmRequest;
    evidence(
      input.signed.encoding === 'hex' && /^0x(?:[0-9a-f]{2})+$/.test(input.signed.raw),
      'Ethereum signed encoding',
    );
    const core = await getWalletCore();
    evidence(
      `0x${Buffer.from(core.Hash.keccak256(Buffer.from(input.signed.raw.slice(2), 'hex'))).toString('hex')}` ===
        input.hash.toLowerCase(),
      'Ethereum signed raw hash',
    );
    const raw = await this.rpc.call('ethereum', 'eth_getTransactionReceipt', [input.hash]);
    if (raw === null) return { state: 'pending' as const };
    const receipt = z
      .object({
        transactionHash: hexHash,
        blockHash: hexHash,
        blockNumber: hexQuantity,
        status: z.enum(['0x0', '0x1']),
        gasUsed: hexQuantity,
        effectiveGasPrice: hexQuantity,
      })
      .parse(raw);
    evidence(
      receipt.transactionHash.toLowerCase() === input.hash.toLowerCase(),
      'receipt transaction hash',
    );
    const tx = z
      .object({
        hash: hexHash,
        from: z.string(),
        to: z.string(),
        value: hexQuantity,
        nonce: hexQuantity,
        input: z.string(),
        blockHash: hexHash,
        blockNumber: hexQuantity,
      })
      .parse(await this.rpc.call('ethereum', 'eth_getTransactionByHash', [input.hash]));
    evidence(
      tx.hash.toLowerCase() === input.hash.toLowerCase() &&
        tx.from.toLowerCase() === input.request.wallet.address &&
        tx.to.toLowerCase() === request.to &&
        BigInt(tx.value).toString() === request.amount &&
        BigInt(tx.nonce).toString() === request.nonce &&
        tx.input === '0x',
      'Ethereum request fields',
    );
    evidence(
      tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
      'receipt inclusion',
    );
    const canonicalRaw = await this.rpc.call('ethereum', 'eth_getBlockByNumber', [
      receipt.blockNumber,
      false,
    ]);
    if (canonicalRaw === null)
      throw new BadGatewayException('Canonical Ethereum block unavailable');
    const canonical = z.object({ hash: hexHash, number: hexQuantity }).parse(canonicalRaw);
    evidence(canonical.number === receipt.blockNumber, 'canonical Ethereum height');
    if (canonical.hash !== receipt.blockHash) return { state: 'reverted' as const };
    const finalizedRaw = await this.rpc.call('ethereum', 'eth_getBlockByNumber', [
      'finalized',
      false,
    ]);
    if (finalizedRaw === null) throw new BadGatewayException('Ethereum finalized head unavailable');
    const finalized = z.object({ hash: hexHash, number: hexQuantity }).parse(finalizedRaw);
    const gasUsed = BigInt(receipt.gasUsed);
    const gasPrice = BigInt(receipt.effectiveGasPrice);
    evidence(
      gasUsed <= BigInt(request.gasLimit) && gasPrice <= BigInt(request.maxFeePerGas),
      'Ethereum fee bounds',
    );
    const checked = z
      .object({ hash: hexHash, number: hexQuantity })
      .parse(await this.rpc.call('ethereum', 'eth_getBlockByNumber', [receipt.blockNumber, false]));
    if (checked.hash !== receipt.blockHash) return { state: 'reverted' as const };
    return {
      state:
        BigInt(receipt.blockNumber) <= BigInt(finalized.number)
          ? receipt.status === '0x1'
            ? ('confirmed' as const)
            : ('failed' as const)
          : ('pending' as const),
      blockHash: receipt.blockHash,
      blockHeight: BigInt(receipt.blockNumber).toString(),
      actualFeeUnits: (gasUsed * gasPrice).toString(),
    };
  }

  private async observeBitcoin(input: {
    hash: string;
    request: SignRequest;
    signed: SignedTransaction;
  }) {
    const request = input.request.transaction as BitcoinRequest;
    let raw: unknown;
    try {
      raw = await this.rpc.call('bitcoin', 'getrawtransaction', [input.hash, true]);
    } catch (error) {
      if (error instanceof RpcFailure && error.rpcCode === -5) return { state: 'pending' as const };
      throw error;
    }
    if (raw === null) return { state: 'pending' as const };
    const transaction = z
      .object({ txid: btcHash, hex: z.string(), blockhash: btcHash.optional() })
      .parse(raw);
    evidence(
      transaction.txid === input.hash &&
        transaction.hex === input.signed.raw &&
        input.signed.encoding === 'hex',
      'Bitcoin signed bytes',
    );
    const decoded = decodeBitcoinSweep(transaction.hex);
    evidence(decoded.txid === input.hash, 'Bitcoin signed raw hash');
    const reservedInputs = new Set(request.utxos.map((utxo) => `${utxo.txid}:${utxo.vout}`));
    evidence(
      decoded.inputs.length === request.utxos.length &&
        reservedInputs.size === request.utxos.length &&
        new Set(decoded.inputs).size === decoded.inputs.length &&
        decoded.inputs.every((ref) => reservedInputs.has(ref)),
      'Bitcoin reserved input set',
    );
    evidence(request.outputs.length === 1 && decoded.outputs.length === 1, 'Bitcoin output count');
    const hotScript = `0014${Buffer.from(regtestWitnessAddress(request.outputs[0].address).program).toString('hex')}`;
    evidence(
      decoded.outputs[0].script === hotScript &&
        decoded.outputs[0].amount.toString() === request.outputs[0].amount,
      'Bitcoin hot output',
    );
    const fee =
      request.utxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n) -
      decoded.outputs[0].amount;
    evidence(fee >= 0n && fee <= 10_000n, 'Bitcoin fee');
    if (!transaction.blockhash) return { state: 'pending' as const };
    const headerSchema = z.object({
      hash: btcHash,
      height: safeInteger,
      confirmations: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    });
    const header = headerSchema.parse(
      await this.rpc.call('bitcoin', 'getblockheader', [transaction.blockhash, true]),
    );
    evidence(header.hash === transaction.blockhash, 'Bitcoin block hash');
    if (
      header.confirmations < 0 ||
      (await this.rpc.call('bitcoin', 'getblockhash', [header.height])) !== header.hash
    )
      return { state: 'reverted' as const };
    const checked = headerSchema.parse(
      await this.rpc.call('bitcoin', 'getblockheader', [transaction.blockhash, true]),
    );
    evidence(
      checked.hash === header.hash && checked.height === header.height,
      'Bitcoin second inclusion check',
    );
    if (
      checked.confirmations < 0 ||
      (await this.rpc.call('bitcoin', 'getblockhash', [header.height])) !== header.hash
    )
      return { state: 'reverted' as const };
    return {
      state: checked.confirmations >= 6 ? ('confirmed' as const) : ('pending' as const),
      blockHash: header.hash,
      blockHeight: header.height.toString(),
      actualFeeUnits: fee.toString(),
    };
  }

  private async observeSolana(input: {
    hash: string;
    request: SignRequest;
    signed: SignedTransaction;
  }) {
    const request = input.request.transaction as SolanaRequest;
    evidence(
      request.outputs.length === 1 && input.signed.encoding === 'base64',
      'Solana output encoding',
    );
    const rawBytes = Buffer.from(input.signed.raw, 'base64');
    evidence(rawBytes.length <= 1232 && rawBytes[0] === 1, 'Solana signature count');
    const core = await getWalletCore();
    evidence(
      core.Base58.encodeNoCheck(rawBytes.subarray(1, 65)) === input.hash,
      'Solana signed signature',
    );
    const expected = await nativeSolanaMessage(
      input.request.wallet.address,
      request.outputs[0].address,
      request.recentBlockhash,
      BigInt(request.outputs[0].amount),
    );
    evidence(rawBytes.subarray(65).equals(expected), 'Solana exact System transfer message');
    const raw = await this.rpc.call('solana', 'getTransaction', [
      input.hash,
      { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 },
    ]);
    if (raw === null) return { state: 'pending' as const };
    const transaction = z
      .object({
        slot: safeInteger,
        transaction: z.tuple([z.string(), z.literal('base64')]),
        meta: z.object({ err: z.unknown(), fee: safeInteger }),
      })
      .parse(raw);
    evidence(transaction.transaction[0] === input.signed.raw, 'Solana canonical signed bytes');
    evidence(transaction.meta.fee <= 100_000, 'Solana fee cap');
    const blockSchema = z.object({ blockhash: z.string(), signatures: z.array(z.string()) });
    const lookup = () =>
      this.rpc.call('solana', 'getBlock', [
        transaction.slot,
        {
          commitment: 'finalized',
          transactionDetails: 'signatures',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
    const blockRaw = await lookup();
    if (blockRaw === null) throw new BadGatewayException('Solana finalized block unavailable');
    const block = blockSchema.parse(blockRaw);
    if (!block.signatures.includes(input.hash)) return { state: 'reverted' as const };
    const checkedRaw = await lookup();
    if (checkedRaw === null) throw new BadGatewayException('Solana finalized block unavailable');
    const checked = blockSchema.parse(checkedRaw);
    if (checked.blockhash !== block.blockhash || !checked.signatures.includes(input.hash))
      return { state: 'reverted' as const };
    return {
      state: transaction.meta.err === null ? ('confirmed' as const) : ('failed' as const),
      blockHash: block.blockhash,
      blockHeight: transaction.slot.toString(),
      actualFeeUnits: String(transaction.meta.fee),
    };
  }
}

// Decode the signed output amounts directly; RPC floating-point BTC values are
// not authoritative for execution fees. This parser accepts the SegWit format
// emitted by Wallet Core and rejects truncated/ambiguous encodings.
function decodeBitcoinSweep(raw: string) {
  evidence(/^(?:[0-9a-f]{2})+$/.test(raw), 'Bitcoin hexadecimal encoding');
  const bytes = Buffer.from(raw, 'hex');
  let offset = 0;
  const take = (length: number) => {
    evidence(offset + length <= bytes.length, 'truncated Bitcoin transaction');
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const compact = () => {
    const prefix = take(1)[0];
    if (prefix < 253) return prefix;
    if (prefix === 253) {
      const value = take(2).readUInt16LE();
      evidence(value >= 253, 'nonminimal Bitcoin length');
      return value;
    }
    if (prefix === 254) {
      const value = take(4).readUInt32LE();
      evidence(value > 65535, 'nonminimal Bitcoin length');
      return value;
    }
    throw new BadGatewayException('Oversized Bitcoin transaction vector');
  };
  const version = take(4);
  evidence(take(2).equals(Buffer.from([0, 1])), 'Bitcoin witness marker');
  const inputCount = compact();
  evidence(inputCount >= 1 && inputCount <= 100, 'Bitcoin input count');
  const inputs: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    const txid = Buffer.from(take(32)).reverse().toString('hex');
    const vout = take(4).readUInt32LE();
    inputs.push(`${txid}:${vout}`);
    take(compact());
    take(4);
  }
  const outputCount = compact();
  evidence(outputCount === 1, 'Bitcoin sweep output count');
  const outputs = [{ amount: take(8).readBigUInt64LE(), script: take(compact()).toString('hex') }];
  const baseEnd = offset;
  for (let i = 0; i < inputCount; i++) {
    const count = compact();
    evidence(count <= 100, 'Bitcoin witness count');
    for (let j = 0; j < count; j++) take(compact());
  }
  const locktime = take(4);
  evidence(offset === bytes.length, 'Bitcoin trailing bytes');
  const base = Buffer.concat([version, bytes.subarray(6, baseEnd), locktime]);
  const txid = Buffer.from(
    createHash('sha256').update(createHash('sha256').update(base).digest()).digest(),
  )
    .reverse()
    .toString('hex');
  return { inputs, outputs, txid };
}
