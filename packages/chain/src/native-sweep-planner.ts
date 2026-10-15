import { BadGatewayException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TW } from '@trustwallet/wallet-core';
import { z } from 'zod';
import {
  BitcoinChain,
  EvmChain,
  SignRequest,
  SignedTransaction,
  signSchema,
} from '../../shared/src/contracts.js';
import { ChainRpcService, RpcFailure } from './chain-rpc.service.js';
import { getWalletCore } from './coin-metadata.js';
import { regtestWitnessAddress } from './bitcoin-address.js';
import { assertEvmExternalAddress, assertSolanaExternalAddress } from './recipient-policy.js';

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
  | 'dust'
  | 'insufficient_balance'
  | 'fee_budget'
  | 'unavailable'
  | 'attention'
  | 'disabled'
  | 'paused_review'
  | 'waiting_resources'
  | 'waiting_funds'
  | 'preparation_expired';
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

function budget(amount: bigint, fee: bigint, minimum: bigint, cap: bigint, withdrawal = false) {
  if (amount <= 0n) defer('insufficient_balance', 'Balance does not cover the fee reserve');
  if (withdrawal) minimum = minimum === 10_000n ? 546n : 1n;
  if (amount < minimum) defer('dust', 'Spendable sweep amount is below the minimum');
  if (fee > cap || (!withdrawal && fee * 100n > amount))
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
    amount?: string;
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

  private async ethereum(input: { sourceAddress: string; hotAddress: string; amount?: string }) {
    assertEvmExternalAddress(input.hotAddress);
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
    const pendingCode = await this.rpc.call('ethereum', 'eth_getCode', [hot, 'pending']);
    if (code !== '0x' || pendingCode !== '0x')
      defer('attention', 'Native Ethereum recipient must have no contract or delegated code');
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
    let amount = input.amount === undefined ? balance - fee : BigInt(input.amount);
    if (balance < amount + fee)
      defer('waiting_funds', 'Hot liquidity cannot cover principal and fees');
    budget(amount, fee, 1_000_000_000_000_000n, 5_000_000_000_000_000n, input.amount !== undefined);
    const exactGas = ((await estimate(amount)) * 120n + 99n) / 100n;
    if (exactGas > gas) {
      gas = exactGas;
      fee = gas * maxFee;
      amount = input.amount === undefined ? balance - fee : BigInt(input.amount);
      if (balance < amount + fee)
        defer('waiting_funds', 'Hot liquidity cannot cover principal and fees');
      budget(
        amount,
        fee,
        1_000_000_000_000_000n,
        5_000_000_000_000_000n,
        input.amount !== undefined,
      );
    }
    if (gas < 21000n || gas > 100000n)
      defer('fee_budget', 'Native Ethereum gas limit exceeds the signing policy');
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

  private async bitcoin(input: { sourceAddress: string; hotAddress: string; amount?: string }) {
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
      amount: input.amount ?? total.toString(),
      toAddress: hot.signingAddress,
      changeAddress: source.signingAddress,
      byteFee: satsPerVbyte.toString(),
      useMaxUtxo: true,
      useMaxAmount: input.amount === undefined,
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
    if (plan.error !== 0)
      defer('waiting_funds', 'Bitcoin hot inputs cannot fund principal and fees');
    const amount = BigInt(plan.amount.toString());
    const fee = BigInt(plan.fee.toString());
    const change = BigInt(plan.change.toString());
    const selected = plan.utxos.map((u) => {
      const hash = Buffer.from(u.outPoint?.hash ?? [])
        .reverse()
        .toString('hex');
      const found = utxos.find(
        (candidate) => candidate.txid === hash && candidate.vout === u.outPoint?.index,
      );
      evidence(!!found, 'Wallet Core selected an unknown input');
      return found;
    });
    const selectedTotal = selected.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    evidence(
      amount + fee + change === selectedTotal &&
        (input.amount === undefined
          ? change === 0n && selected.length === utxos.length
          : amount.toString() === input.amount),
      'Wallet Core exact native payment plan',
    );
    budget(amount, fee, 10_000n, 10_000n, input.amount !== undefined);
    const request: SignRequest['transaction'] = {
      chain: 'bitcoin',
      outputs: [{ address: hot.address, amount: amount.toString() }],
      utxos: selected,
      satsPerVbyte: Number(satsPerVbyte),
      ...(input.amount === undefined
        ? { sweepAll: true as const }
        : { changeAmount: change.toString() }),
    };
    return {
      request,
      amount: amount.toString(),
      maxFeeUnits: fee.toString(),
      resourceKeys: selected.map((utxo) => `utxo:${utxo.txid}:${utxo.vout}`),
      expiresAt: expires(),
    };
  }

  private async withdrawalSolanaRecipient(
    address: string,
    amount: bigint,
    rent: bigint,
    floor: number,
  ) {
    await assertSolanaExternalAddress(address);
    const result = z
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
      .parse(
        await this.rpc.call('solana', 'getAccountInfo', [
          address,
          { commitment: 'finalized', encoding: 'base64', minContextSlot: floor },
        ]),
      );
    if (result.context.slot < floor) defer('unavailable', 'Solana recipient context is stale');
    if (
      result.value &&
      (result.value.owner !== SYSTEM ||
        result.value.executable ||
        Buffer.from(result.value.data[0], 'base64').length !== 0)
    )
      defer('attention', 'Native withdrawal recipient must be an ordinary System account');
    if (BigInt(result.value?.lamports ?? 0) + amount < rent)
      defer('dust', 'Withdrawal cannot create or retain a rent-exempt recipient');
  }

  private async solana(input: { sourceAddress: string; hotAddress: string; amount?: string }) {
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
    const fee = await feeFor(input.amount === undefined ? provisional : BigInt(input.amount));
    const amount = input.amount === undefined ? available - rent - fee : BigInt(input.amount);
    if (available < amount + rent + fee)
      defer('waiting_funds', 'Hot liquidity cannot cover principal, fees and rent');
    budget(amount, fee, 1_000_000n, 100_000n, input.amount !== undefined);
    await this.withdrawalSolanaRecipient(
      input.hotAddress,
      amount,
      rent,
      Math.max(balance.context.slot, account.context.slot),
    );
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

  /** Re-read the exact reserved resources immediately before policy authorization.
   * Newly arrived balances and UTXOs never alter an existing prepared request.
   */
  async revalidate(input: SignRequest, maxFeeUnits: string): Promise<void> {
    const request = signSchema.parse(input);
    const chain = request.wallet.chain;
    if (chain !== 'ethereum' && chain !== 'bitcoin' && chain !== 'solana')
      defer('attention', 'Native sweep chain is not permitted');
    if (!request.wallet.network) defer('attention', 'Native sweep network is required');
    const fee = BigInt(
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .parse(maxFeeUnits),
    );
    try {
      await this.verify(chain, request.wallet.network);
      if (chain === 'ethereum') await this.revalidateEthereum(request, fee);
      else if (chain === 'bitcoin') await this.revalidateBitcoin(request, fee);
      else await this.revalidateSolana(request, fee);
    } catch (error) {
      if (error instanceof RpcFailure)
        defer('unavailable', 'Canonical RPC is unavailable; retain the prepared reservation');
      throw error;
    }
  }

  private async revalidateEthereum(input: SignRequest, fee: bigint) {
    const request = input.transaction as EvmRequest;
    const source = input.wallet.address;
    assertEvmExternalAddress(request.to);
    if (source === request.to || request.chainId !== '11155111')
      defer('attention', 'Invalid native Ethereum sweep destination or chain');
    const amount = BigInt(request.amount);
    const gas = BigInt(request.gasLimit);
    const maxFee = BigInt(request.maxFeePerGas);
    const priority = BigInt(request.maxPriorityFeePerGas);
    if (
      fee !== gas * maxFee ||
      maxFee > 100_000_000_000n ||
      priority > 2_000_000_000n ||
      priority > maxFee
    )
      defer('fee_budget', 'Prepared Ethereum fee authorization is inconsistent with policy');
    // Hot withdrawals and purpose-authorized management1 funding are exact payments.
    budget(
      amount,
      fee,
      1_000_000_000_000_000n,
      5_000_000_000_000_000n,
      input.wallet.account === 0 || input.wallet.account === 1,
    );
    const [
      finalizedRaw,
      pendingRaw,
      latestNonceRaw,
      pendingNonceRaw,
      blockRaw,
      priorityRaw,
      codeRaw,
      gasRaw,
    ] = await Promise.all([
      this.rpc.call('ethereum', 'eth_getBalance', [source, 'finalized']),
      this.rpc.call('ethereum', 'eth_getBalance', [source, 'pending']),
      this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'latest']),
      this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'pending']),
      this.rpc.call('ethereum', 'eth_getBlockByNumber', ['latest', false]),
      this.rpc.call('ethereum', 'eth_maxPriorityFeePerGas', []),
      this.rpc.call('ethereum', 'eth_getCode', [request.to, 'finalized']),
      this.rpc.call('ethereum', 'eth_estimateGas', [
        {
          from: source,
          to: request.to,
          value: `0x${amount.toString(16)}`,
          maxFeePerGas: `0x${maxFee.toString(16)}`,
          maxPriorityFeePerGas: `0x${priority.toString(16)}`,
        },
      ]),
    ]);
    const pendingCode = await this.rpc.call('ethereum', 'eth_getCode', [request.to, 'pending']);
    if (codeRaw !== '0x' || pendingCode !== '0x')
      defer('attention', 'Native Ethereum recipient must have no contract or delegated code');
    if (
      BigInt(hexQuantity.parse(latestNonceRaw)) !== BigInt(request.nonce) ||
      BigInt(hexQuantity.parse(pendingNonceRaw)) !== BigInt(request.nonce)
    )
      defer('waiting_resources', 'Prepared source nonce is occupied or has advanced');
    if (
      BigInt(hexQuantity.parse(finalizedRaw)) < amount + fee ||
      BigInt(hexQuantity.parse(pendingRaw)) < amount + fee
    )
      defer(
        'waiting_funds',
        'Prepared Ethereum balance no longer covers principal and reserved fees',
      );
    const baseFee = BigInt(z.object({ baseFeePerGas: hexQuantity }).parse(blockRaw).baseFeePerGas);
    const quotedPriority = BigInt(hexQuantity.parse(priorityRaw));
    if (
      quotedPriority > priority ||
      baseFee + priority > maxFee ||
      BigInt(hexQuantity.parse(gasRaw)) > gas
    )
      defer('fee_budget', 'Fresh Ethereum execution costs exceed the immutable preparation');
  }

  private async revalidateBitcoin(input: SignRequest, fee: bigint) {
    const request = input.transaction as BitcoinRequest;
    if (
      request.outputs.length !== 1 ||
      (request.sweepAll !== true && request.changeAmount === undefined) ||
      (request.sweepAll === true && request.changeAmount !== undefined)
    )
      defer('attention', 'Bitcoin sweep must have one hot output and no change');
    const source = regtestWitnessAddress(input.wallet.address);
    const hot = regtestWitnessAddress(request.outputs[0].address);
    if (source.program.length !== 20 || hot.program.length !== 20 || source.address === hot.address)
      defer('attention', 'Bitcoin sweep requires distinct P2WPKH source and hot addresses');
    const ownScript = `0014${Buffer.from(source.program).toString('hex')}`;
    if (new Set(request.utxos.map((u) => `${u.txid}:${u.vout}`)).size !== request.utxos.length)
      defer('attention', 'Duplicate prepared Bitcoin outpoint');
    const amount = BigInt(request.outputs[0].amount);
    if (
      request.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n) !==
        amount + fee + BigInt(request.changeAmount ?? '0') ||
      request.satsPerVbyte > 100
    )
      defer('fee_budget', 'Prepared Bitcoin principal or fee budget is inconsistent');
    budget(amount, fee, 10_000n, 10_000n, input.wallet.account === 0);
    for (const utxo of request.utxos) {
      if (utxo.script !== ownScript)
        defer('attention', 'Prepared Bitcoin script is not owned by source');
      const raw = await this.rpc.call('bitcoin', 'gettxout', [utxo.txid, utxo.vout, true]);
      if (raw === null) defer('waiting_resources', 'Prepared Bitcoin outpoint has been spent');
      const output = z
        .object({
          value: z.union([z.number(), z.string()]),
          confirmations: safeInteger,
          coinbase: z.boolean(),
          scriptPubKey: z.object({ hex: z.string(), address: z.string().optional() }),
        })
        .parse(raw);
      evidence(
        output.scriptPubKey.hex === ownScript &&
          (!output.scriptPubKey.address || output.scriptPubKey.address === source.address),
        'prepared Bitcoin outpoint ownership',
      );
      evidence(
        bitcoinDecimalUnits(output.value) === BigInt(utxo.amount),
        'prepared Bitcoin outpoint amount',
      );
      if (output.confirmations < 6 || (output.coinbase && output.confirmations < 100))
        defer('waiting_resources', 'Prepared Bitcoin outpoint is no longer mature');
    }
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
    const rate =
      estimate.feerate === undefined ? 2n : (bitcoinDecimalUnits(estimate.feerate) + 999n) / 1000n;
    if (rate < 1n || rate > BigInt(request.satsPerVbyte))
      defer('fee_budget', 'Fresh Bitcoin fee estimate exceeds the immutable preparation');
  }

  private async revalidateSolana(input: SignRequest, fee: bigint) {
    const request = input.transaction as SolanaRequest;
    if (request.outputs.length !== 1 || request.outputs[0].address === input.wallet.address)
      defer('attention', 'Native Solana sweep requires one distinct hot recipient');
    const amount = BigInt(request.outputs[0].amount);
    budget(amount, fee, 1_000_000n, 100_000n, input.wallet.account === 0);
    const [balanceRaw, accountRaw] = await Promise.all([
      this.rpc.call('solana', 'getBalance', [input.wallet.address, { commitment: 'finalized' }]),
      this.rpc.call('solana', 'getAccountInfo', [
        input.wallet.address,
        { commitment: 'finalized', encoding: 'base64' },
      ]),
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
    if (!account.value) defer('waiting_funds', 'Prepared Solana account no longer exists');
    if (
      account.value.owner !== SYSTEM ||
      account.value.executable ||
      Buffer.from(account.value.data[0], 'base64').length !== 0
    )
      defer('attention', 'Prepared Solana source is no longer an ordinary System account');
    const floor = Math.max(balance.context.slot, account.context.slot);
    const rent = BigInt(
      safeInteger.parse(
        await this.rpc.call('solana', 'getMinimumBalanceForRentExemption', [
          0,
          { commitment: 'finalized' },
        ]),
      ),
    );
    if (rent > 5_000_000n) defer('fee_budget', 'Solana retained rent exceeds the pinned budget');
    await this.withdrawalSolanaRecipient(request.outputs[0].address, amount, rent, floor);
    if (
      BigInt(balance.value) < amount + fee + rent ||
      BigInt(account.value.lamports) < amount + fee + rent
    )
      defer(
        'waiting_funds',
        'Prepared Solana balance no longer covers principal, fee and retained rent',
      );
    const message = await nativeSolanaMessage(
      input.wallet.address,
      request.outputs[0].address,
      request.recentBlockhash,
      amount,
    );
    const [feeRaw, heightRaw, validRaw] = await Promise.all([
      this.rpc.call('solana', 'getFeeForMessage', [
        message.toString('base64'),
        { commitment: 'finalized', minContextSlot: floor },
      ]),
      this.rpc.call('solana', 'getBlockHeight', [
        { commitment: 'finalized', minContextSlot: floor },
      ]),
      this.rpc.call('solana', 'isBlockhashValid', [
        request.recentBlockhash,
        { commitment: 'finalized', minContextSlot: floor },
      ]),
    ]);
    const quote = z
      .object({ context: z.object({ slot: safeInteger }), value: safeInteger.nullable() })
      .parse(feeRaw);
    const valid = z
      .object({ context: z.object({ slot: safeInteger }), value: z.boolean() })
      .parse(validRaw);
    if (quote.context.slot < floor || valid.context.slot < floor || quote.value === null)
      defer('unavailable', 'Fresh Solana evidence is unavailable for the prepared message context');
    if (safeInteger.parse(heightRaw) >= request.lastValidBlockHeight || !valid.value)
      defer('preparation_expired', 'Prepared Solana blockhash is no longer valid');
    if (BigInt(quote.value) !== fee)
      defer('fee_budget', 'Solana fee changed for the immutable prepared message');
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
    const decoded = decodeEthereumSweep(input.signed.raw);
    evidence(
      decoded.chainId === BigInt(request.chainId) &&
        decoded.nonce === BigInt(request.nonce) &&
        decoded.amount === BigInt(request.amount) &&
        decoded.to === request.to &&
        decoded.gasLimit === BigInt(request.gasLimit) &&
        decoded.maxFeePerGas === BigInt(request.maxFeePerGas) &&
        decoded.maxPriorityFeePerGas === BigInt(request.maxPriorityFeePerGas),
      'Ethereum exact signed request fields',
    );
    const recovered = core.PublicKey.recover(
      decoded.signature,
      core.Hash.keccak256(decoded.signingBytes),
    );
    try {
      const address = core.AnyAddress.createWithPublicKey(recovered, core.CoinType.ethereum);
      try {
        evidence(
          address.description().toLowerCase() === input.request.wallet.address,
          'Ethereum signed source',
        );
      } finally {
        address.delete();
      }
    } finally {
      recovered.delete();
    }
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
    const { feeUnits } = verifyBitcoinPayment(input.request, input.signed);
    const fee = BigInt(feeUnits);
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
    const sourceKey = core.PublicKey.createWithData(
      core.Base58.decodeNoCheck(input.request.wallet.address),
      core.PublicKeyType.ed25519,
    );
    try {
      evidence(sourceKey.verify(rawBytes.subarray(1, 65), expected), 'Solana source signature');
    } finally {
      sourceKey.delete();
    }
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
    evidence(compact() === 0, 'Bitcoin native scriptSig');
    evidence(take(4).readUInt32LE() === 0xffffffff, 'Bitcoin native input sequence');
  }
  const outputCount = compact();
  evidence(outputCount >= 1 && outputCount <= 51, 'Bitcoin native output count');
  const outputs = Array.from({ length: outputCount }, () => ({
    amount: take(8).readBigUInt64LE(),
    script: take(compact()).toString('hex'),
  }));
  const baseEnd = offset;
  for (let i = 0; i < inputCount; i++) {
    const count = compact();
    evidence(count === 2, 'Bitcoin native witness count');
    const signature = take(compact());
    const publicKey = take(compact());
    evidence(
      signature.length >= 9 &&
        signature.length <= 73 &&
        signature[signature.length - 1] === 1 &&
        publicKey.length === 33 &&
        (publicKey[0] === 2 || publicKey[0] === 3),
      'Bitcoin native witness fields',
    );
  }
  const locktime = take(4);
  evidence(locktime.readUInt32LE() === 0, 'Bitcoin native locktime');
  evidence(offset === bytes.length, 'Bitcoin trailing bytes');
  const base = Buffer.concat([version, bytes.subarray(6, baseEnd), locktime]);
  const txid = Buffer.from(
    createHash('sha256').update(createHash('sha256').update(base).digest()).digest(),
  )
    .reverse()
    .toString('hex');
  return { inputs, outputs, txid, virtualSize: Math.ceil((base.length * 3 + bytes.length) / 4) };
}

/** Decode and compare all committed outputs before submission or financial observation. */
export function verifyBitcoinPayment(request: SignRequest, signed: SignedTransaction) {
  if (request.transaction.chain !== 'bitcoin' || signed.encoding !== 'hex')
    throw new Error('Bitcoin payment encoding mismatch');
  const tx = request.transaction,
    decoded = decodeBitcoinSweep(signed.raw);
  evidence(decoded.txid === signed.txHash, 'Bitcoin signed hash');
  const keys = tx.utxos.map((u) => `${u.txid}:${u.vout}`);
  evidence(
    new Set(keys).size === keys.length &&
      decoded.inputs.length === keys.length &&
      new Set(decoded.inputs).size === decoded.inputs.length &&
      decoded.inputs.every((key) => keys.includes(key)),
    'Bitcoin reserved input set',
  );
  const change = BigInt(tx.changeAmount ?? '0');
  evidence(
    decoded.outputs.length === tx.outputs.length + (change > 0n ? 1 : 0),
    'Bitcoin complete output count',
  );
  const script = (address: string) =>
    '0014' + Buffer.from(regtestWitnessAddress(address).program).toString('hex');
  for (const [index, payout] of tx.outputs.entries()) {
    const output = decoded.outputs[index + (change > 0n && index > 0 ? 1 : 0)];
    evidence(
      output.script === script(payout.address) && output.amount === BigInt(payout.amount),
      'Bitcoin exact payout output',
    );
  }
  if (change > 0n)
    evidence(
      decoded.outputs[1].script === script(request.wallet.address) &&
        decoded.outputs[1].amount === change,
      'Bitcoin hot-owned change',
    );
  const fee =
    tx.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n) -
    decoded.outputs.reduce((sum, o) => sum + o.amount, 0n);
  evidence(
    fee >= BigInt(decoded.virtualSize * tx.satsPerVbyte) && fee <= 10000n,
    'Bitcoin exact fee and signed size',
  );
  return { feeUnits: fee.toString(), virtualSize: decoded.virtualSize };
}

// Minimal canonical RLP reader for Wallet Core's EIP-1559 native transfers.
// The prepared request and recovered source are checked before querying receipts.
function decodeEthereumSweep(raw: string) {
  const bytes = Buffer.from(raw.slice(2), 'hex');
  evidence(bytes[0] === 2, 'Ethereum native sweep envelope');
  type Rlp = Buffer | Rlp[];
  let cursor = 1;
  const take = (count: number) => {
    evidence(count >= 0 && cursor + count <= bytes.length, 'truncated Ethereum RLP');
    const value = bytes.subarray(cursor, cursor + count);
    cursor += count;
    return value;
  };
  const length = (count: number) => {
    const encoded = take(count);
    evidence(encoded[0] !== 0 && count <= 4, 'noncanonical Ethereum RLP length');
    return Number(BigInt(`0x${encoded.toString('hex')}`));
  };
  const read = (depth: number): Rlp => {
    evidence(depth <= 2, 'Ethereum RLP nesting');
    const prefix = take(1)[0];
    if (prefix < 0x80) return Buffer.from([prefix]);
    if (prefix <= 0xbf) {
      const size = prefix <= 0xb7 ? prefix - 0x80 : length(prefix - 0xb7);
      evidence(prefix <= 0xb7 || size >= 56, 'noncanonical Ethereum string length');
      const value = take(size);
      evidence(size !== 1 || value[0] >= 0x80, 'noncanonical Ethereum RLP string');
      return value;
    }
    const size = prefix <= 0xf7 ? prefix - 0xc0 : length(prefix - 0xf7);
    evidence(prefix <= 0xf7 || size >= 56, 'noncanonical Ethereum list length');
    const end = cursor + size;
    evidence(end <= bytes.length, 'truncated Ethereum RLP list');
    const list: Rlp[] = [];
    while (cursor < end) {
      evidence(list.length < 12, 'Ethereum native sweep field count');
      list.push(read(depth + 1));
    }
    evidence(cursor === end, 'Ethereum RLP list size');
    return list;
  };
  const fields = read(0);
  evidence(
    Array.isArray(fields) && fields.length === 12 && cursor === bytes.length,
    'Ethereum EIP-1559 field count',
  );
  const field = (index: number) => {
    const value = fields[index];
    evidence(Buffer.isBuffer(value), 'Ethereum native scalar field');
    return value;
  };
  const uint = (index: number) => {
    const value = field(index);
    evidence(
      value.length <= 32 && (value.length === 0 || value[0] !== 0),
      'Ethereum canonical integer',
    );
    return value.length === 0 ? 0n : BigInt(`0x${value.toString('hex')}`);
  };
  evidence(
    field(5).length === 20 &&
      field(7).length === 0 &&
      Array.isArray(fields[8]) &&
      fields[8].length === 0,
    'Ethereum native recipient, data and access list',
  );
  const parity = uint(9);
  evidence(parity <= 1n && uint(10) > 0n && uint(11) > 0n, 'Ethereum signature fields');
  const encode = (value: Rlp): Buffer => {
    const list = Array.isArray(value);
    const data = list ? Buffer.concat(value.map(encode)) : value;
    if (!list && data.length === 1 && data[0] < 0x80) return data;
    const base = list ? 0xc0 : 0x80;
    if (data.length < 56) return Buffer.concat([Buffer.from([base + data.length]), data]);
    let hex = data.length.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const encodedLength = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([base + 55 + encodedLength.length]), encodedLength, data]);
  };
  return {
    chainId: uint(0),
    nonce: uint(1),
    maxPriorityFeePerGas: uint(2),
    maxFeePerGas: uint(3),
    gasLimit: uint(4),
    to: `0x${field(5).toString('hex')}`,
    amount: uint(6),
    signingBytes: Buffer.concat([Buffer.from([2]), encode(fields.slice(0, 9))]),
    signature: Buffer.concat([
      Buffer.from(uint(10).toString(16).padStart(64, '0'), 'hex'),
      Buffer.from(uint(11).toString(16).padStart(64, '0'), 'hex'),
      Buffer.from([Number(parity)]),
    ]),
  };
}
