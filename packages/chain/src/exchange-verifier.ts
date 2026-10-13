import { BadGatewayException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CanonicalAsset } from '../../queue/src/exchange-contracts.js';
import { Chain, isBitcoinChain, isEvmChain } from '../../shared/src/contracts.js';
import {
  ExchangeDiscoverySignal,
  exchangeDiscoverySchema,
} from '../../shared/src/exchange-discovery.js';
import { ChainRpcService, RpcFailure } from './chain-rpc.service.js';

export const EXCHANGE_VERIFIER_OPTIONS = Symbol('EXCHANGE_VERIFIER_OPTIONS');
export interface ExchangeVerifierOptions {
  evmTraceMode?: 'callTracer';
}
export interface VerifiedExchangeTransfer {
  identity: {
    kind: 'bitcoin.vout' | 'evm.log' | 'evm.trace' | 'evm.native' | 'solana.instruction';
    id: string;
  };
  from: string | null;
  to: string;
  asset: CanonicalAsset;
  amount: string;
  destinationOwnerProgram?: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
}
export interface VerifiedExchangeTransaction {
  state: 'pending' | 'finalized' | 'reverted' | 'failed';
  chain: Chain;
  network: string;
  transactionHash: string;
  blockHash?: string;
  blockHeight?: string;
  transfers: VerifiedExchangeTransfer[];
  // True only when included canonical chain data provided the complete supported
  // transfer set. Missing/pruned RPC history is not evidence of transfer absence.
  transfersComplete?: boolean;
  fee?: { asset: CanonicalAsset; amount: string; payer?: string };
  spentAddresses?: string[];
  spentInputs?: { address: string; amount: string; outpoint: string }[];
  tokenAccounts?: {
    address: string;
    owner: string;
    mint: string;
    programId: string;
    decimals?: number;
    preAmount?: string;
    postAmount?: string;
  }[];
}

const evmHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase());
const btcHash = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase());
const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const solAddress = base58.min(32).max(44);
const signature = base58.min(64).max(88);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const CLASSIC_SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const NONMOVING_SOL_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

function mismatch(message: string): never {
  throw new BadGatewayException(`Canonical exchange verification failed: ${message}`);
}

function same(a: string, b: string, reason: string) {
  if (a !== b) mismatch(reason);
}

function units(value: unknown): string {
  return typeof value === 'number' ? BigInt(integer.parse(value)).toString() : uint.parse(value);
}

function native(signal: ExchangeDiscoverySignal): CanonicalAsset {
  return { chain: signal.chain, network: signal.network, assetId: `token:${signal.chain}:native` };
}

function result(signal: ExchangeDiscoverySignal): VerifiedExchangeTransaction {
  return {
    state: 'pending',
    chain: signal.chain,
    network: signal.network,
    transactionHash: signal.transactionHash,
    transfers: [],
    transfersComplete: false,
  };
}

const evmTransaction = z.object({
  hash: evmHash,
  chainId: quantity.optional(),
  from: evmAddress,
  to: evmAddress.nullable(),
  value: quantity,
  blockHash: evmHash.nullable(),
  blockNumber: quantity.nullable(),
});
const evmBlock = z.object({ hash: evmHash, number: quantity });
const evmReceipt = z.object({
  transactionHash: evmHash,
  blockHash: evmHash,
  blockNumber: quantity,
  from: evmAddress,
  to: evmAddress.nullable(),
  contractAddress: evmAddress.nullable().optional(),
  status: z.enum(['0x0', '0x1']),
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  logs: z.array(
    z.object({
      address: evmAddress,
      transactionHash: evmHash,
      blockHash: evmHash,
      blockNumber: quantity,
      logIndex: quantity,
      topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      removed: z.boolean().optional(),
    }),
  ),
});
interface TraceFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: TraceFrame[];
}
const traceFrame: z.ZodType<TraceFrame> = z.lazy(() =>
  z.object({
    type: z.enum([
      'CALL',
      'STATICCALL',
      'DELEGATECALL',
      'CALLCODE',
      'CREATE',
      'CREATE2',
      'SELFDESTRUCT',
    ]),
    from: evmAddress,
    to: evmAddress.optional(),
    value: quantity.optional(),
    error: z.string().optional(),
    calls: z.array(traceFrame).optional(),
  }),
);

@Injectable()
export class ExchangeVerifier {
  constructor(
    private readonly rpc: ChainRpcService,
    @Optional()
    @Inject(EXCHANGE_VERIFIER_OPTIONS)
    private readonly options: ExchangeVerifierOptions = {},
  ) {}

  async verify(input: ExchangeDiscoverySignal): Promise<VerifiedExchangeTransaction> {
    const signal = exchangeDiscoverySchema.parse(input);
    await this.verifyConfiguredNetwork(signal.chain, signal.network);
    if (isEvmChain(signal.chain)) return this.verifyEvm(signal);
    if (isBitcoinChain(signal.chain)) {
      if (signal.chain !== 'bitcoin') mismatch('uncertified Bitcoin-family chain');
      return this.verifyBitcoin(signal);
    }
    return this.verifySolana(signal);
  }

  async isCanonicalBlock(
    chain: Chain,
    network: string,
    height: string,
    hash: string,
  ): Promise<boolean | null> {
    await this.verifyConfiguredNetwork(chain, network);
    const number = BigInt(uint.parse(height));
    try {
      if (isEvmChain(chain)) {
        const raw = await this.rpc.call(chain, 'eth_getBlockByNumber', [
          `0x${number.toString(16)}`,
          false,
        ]);
        if (raw === null) return null;
        const block = evmBlock.parse(raw);
        same(BigInt(block.number).toString(), height, 'canonical lookup height mismatch');
        return block.hash === evmHash.parse(hash);
      }
      if (number > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      if (isBitcoinChain(chain)) {
        if (chain !== 'bitcoin') mismatch('uncertified Bitcoin-family chain');
        const raw = await this.rpc.call(chain, 'getblockhash', [Number(number)]);
        return raw === null ? null : btcHash.parse(raw) === btcHash.parse(hash);
      }
      const raw = await this.rpc.call(chain, 'getBlock', [
        Number(number),
        { commitment: 'finalized', transactionDetails: 'none', rewards: false },
      ]);
      if (raw === null) return null;
      return z.object({ blockhash: solAddress }).parse(raw).blockhash === solAddress.parse(hash);
    } catch (error) {
      // Missing/pruned history or an unavailable RPC is not proof of a reorg.
      if (error instanceof RpcFailure) return null;
      throw error;
    }
  }

  private async verifyConfiguredNetwork(chain: Chain, network: string) {
    same(network, this.rpc.networkIdentity(chain), 'discovery network mismatch');
    if (chain === 'bitcoin' && network === 'regtest') {
      // Existing transaction preparation still rejects regtest. A discovery
      // verifier requires an explicitly configured RPC reporting regtest.
      const info = z
        .object({ chain: z.literal('regtest') })
        .parse(await this.rpc.call(chain, 'getblockchaininfo', []));
      same(info.chain, network, 'Bitcoin RPC network mismatch');
    } else await this.rpc.verifyNetwork(chain);
  }

  private async verifyEvm(signal: ExchangeDiscoverySignal): Promise<VerifiedExchangeTransaction> {
    evmHash.parse(signal.transactionHash);
    const output = result(signal);
    const [rawReceipt, rawTransaction] = await Promise.all([
      this.rpc.call(signal.chain, 'eth_getTransactionReceipt', [signal.transactionHash]),
      this.rpc.call(signal.chain, 'eth_getTransactionByHash', [signal.transactionHash]),
    ]);
    if (rawReceipt === null) {
      if (rawTransaction !== null) {
        const tx = evmTransaction.parse(rawTransaction);
        same(tx.hash, signal.transactionHash, 'transaction hash mismatch');
        if (tx.chainId)
          same(BigInt(tx.chainId).toString(), signal.network, 'transaction chain mismatch');
      }
      return output;
    }
    const receipt = evmReceipt.parse(rawReceipt);
    const tx = evmTransaction.parse(rawTransaction);
    same(receipt.transactionHash, signal.transactionHash, 'receipt transaction mismatch');
    same(tx.hash, signal.transactionHash, 'transaction hash mismatch');
    if (tx.chainId)
      same(BigInt(tx.chainId).toString(), signal.network, 'transaction chain mismatch');
    same(tx.blockHash ?? '', receipt.blockHash, 'transaction block mismatch');
    same(tx.blockNumber ?? '', receipt.blockNumber, 'transaction height mismatch');
    same(tx.from, receipt.from, 'receipt source mismatch');
    same(tx.to ?? '', receipt.to ?? '', 'receipt destination mismatch');
    output.blockHash = receipt.blockHash;
    output.blockHeight = BigInt(receipt.blockNumber).toString();
    const canonicalRaw = await this.rpc.call(signal.chain, 'eth_getBlockByNumber', [
      receipt.blockNumber,
      false,
    ]);
    if (canonicalRaw === null) return output;
    const canonical = evmBlock.parse(canonicalRaw);
    if (canonical.hash !== receipt.blockHash) return { ...output, state: 'reverted' };
    same(canonical.number, receipt.blockNumber, 'canonical block height mismatch');
    let finalizedRaw: unknown;
    try {
      finalizedRaw = await this.rpc.call(signal.chain, 'eth_getBlockByNumber', [
        'finalized',
        false,
      ]);
    } catch (error) {
      // An unsupported finalized tag is pending, never a confirmation fallback.
      if (!(error instanceof RpcFailure) || ![-32601, -32602, -32000].includes(error.rpcCode ?? 0))
        throw error;
      finalizedRaw = null;
    }
    if (finalizedRaw !== null) {
      const finalized = evmBlock.parse(finalizedRaw);
      if (BigInt(receipt.blockNumber) <= BigInt(finalized.number))
        output.state = receipt.status === '0x1' ? 'finalized' : 'failed';
    }
    output.fee = {
      asset: native(signal),
      amount: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
      payer: tx.from,
    };
    output.spentAddresses = [tx.from];
    if (receipt.status === '0x0') return { ...output, transfersComplete: true };
    const destination = tx.to ?? receipt.contractAddress;
    if (BigInt(tx.value) > 0n) {
      if (!destination) mismatch('missing native destination');
      output.transfers.push({
        identity: { kind: 'evm.native', id: `${tx.hash}:native` },
        from: tx.from,
        to: destination,
        asset: native(signal),
        amount: BigInt(tx.value).toString(),
      });
    }
    const positions = new Set<string>();
    for (const log of receipt.logs) {
      same(log.transactionHash, tx.hash, 'log transaction mismatch');
      same(log.blockHash, receipt.blockHash, 'log block mismatch');
      same(log.blockNumber, receipt.blockNumber, 'log height mismatch');
      if (log.removed) mismatch('removed log in canonical receipt');
      const position = BigInt(log.logIndex).toString();
      if (positions.has(position)) mismatch('duplicate log position');
      positions.add(position);
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      if (
        !/^0x[0-9a-fA-F]{64}$/.test(log.data) ||
        !log.topics.slice(1).every((topic) => /^0x0{24}[0-9a-fA-F]{40}$/.test(topic))
      )
        mismatch('malformed fungible Transfer log');
      const amount = BigInt(log.data);
      if (amount === 0n) continue;
      output.transfers.push({
        identity: { kind: 'evm.log', id: `${tx.hash}:log:${position}` },
        from: `0x${log.topics[1].slice(-40).toLowerCase()}`,
        to: `0x${log.topics[2].slice(-40).toLowerCase()}`,
        asset: { ...native(signal), assetId: `token:${signal.chain}:erc20:${log.address}` },
        amount: amount.toString(),
      });
    }
    if (this.options.evmTraceMode === 'callTracer') {
      const tree = traceFrame.parse(
        await this.rpc.call(signal.chain, 'debug_traceTransaction', [
          tx.hash,
          { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } },
        ]),
      );
      same(tree.from, tx.from, 'trace root source mismatch');
      same(tree.to ?? '', destination ?? '', 'trace root destination mismatch');
      same(
        BigInt(tree.value ?? '0x0').toString(),
        BigInt(tx.value).toString(),
        'trace root value mismatch',
      );
      if (tree.error) mismatch('successful receipt with reverted trace');
      const visit = (frame: TraceFrame, path: number[]) => {
        if (frame.error) return;
        if (
          path.length > 0 &&
          ['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) &&
          BigInt(frame.value ?? '0x0') > 0n
        ) {
          if (!frame.to) mismatch('trace destination missing');
          output.transfers.push({
            identity: { kind: 'evm.trace', id: `${tx.hash}:trace:${path.join('.')}` },
            from: frame.from,
            to: frame.to,
            asset: native(signal),
            amount: BigInt(frame.value!).toString(),
          });
        }
        frame.calls?.forEach((child, index) => visit(child, [...path, index]));
      };
      visit(tree, []);
    }
    // A reorg between tracing and publication must not yield a finalized credit.
    const checked = await this.rpc.call(signal.chain, 'eth_getBlockByNumber', [
      receipt.blockNumber,
      false,
    ]);
    if (checked === null)
      return {
        ...output,
        state: 'pending',
        transfers: [],
        transfersComplete: false,
        fee: undefined,
        spentAddresses: [],
      };
    if (evmBlock.parse(checked).hash !== receipt.blockHash)
      return { ...output, state: 'reverted', transfers: [], fee: undefined, spentAddresses: [] };
    return { ...output, transfersComplete: true };
  }

  private async verifyBitcoin(
    signal: ExchangeDiscoverySignal,
  ): Promise<VerifiedExchangeTransaction> {
    btcHash.parse(signal.transactionHash);
    const output = result(signal);
    let raw: unknown;
    try {
      raw = await this.rpc.call(signal.chain, 'getrawtransaction', [signal.transactionHash, true]);
    } catch (error) {
      if (error instanceof RpcFailure && error.rpcCode === -5) return output;
      throw error;
    }
    if (raw === null) return output;
    const tx = bitcoinRpcTransaction.parse(raw);
    same(tx.txid, signal.transactionHash, 'Bitcoin transaction mismatch');
    const decoded = decodeBitcoin(tx.hex);
    same(decoded.txid, tx.txid, 'Bitcoin raw transaction hash mismatch');
    validateBitcoinOutputs(tx, decoded);
    if (tx.blockhash) {
      const header = bitcoinHeader.parse(
        await this.rpc.call(signal.chain, 'getblockheader', [tx.blockhash, true]),
      );
      same(header.hash, tx.blockhash, 'Bitcoin block hash mismatch');
      output.blockHash = header.hash;
      output.blockHeight = header.height.toString();
      if (header.confirmations < 0) return { ...output, state: 'reverted' };
      const canonical = btcHash.parse(
        await this.rpc.call(signal.chain, 'getblockhash', [header.height]),
      );
      if (canonical !== header.hash) return { ...output, state: 'reverted' };
      if (header.confirmations >= (decoded.coinbase ? 100 : 6)) output.state = 'finalized';
    }
    output.transfers = tx.vout.flatMap((vout) => {
      const amount = decoded.outputs[vout.n].amount;
      const address = bitcoinOutputAddress(vout);
      return amount > 0n && address
        ? [
            {
              identity: { kind: 'bitcoin.vout' as const, id: `${tx.txid}:${vout.n}` },
              from: null,
              to: address,
              asset: native(signal),
              amount: amount.toString(),
            },
          ]
        : [];
    });
    if (!decoded.coinbase) {
      let inputs = 0n;
      const spentInputs: NonNullable<VerifiedExchangeTransaction['spentInputs']> = [];
      const addresses = new Set<string>();
      const seenInputs = new Set<string>();
      for (const input of decoded.inputs) {
        const outpoint = `${input.txid}:${input.vout}`;
        if (seenInputs.has(outpoint)) mismatch('duplicate Bitcoin input');
        seenInputs.add(outpoint);
        const previous = bitcoinRpcTransaction.parse(
          await this.rpc.call(signal.chain, 'getrawtransaction', [input.txid, true]),
        );
        same(previous.txid, input.txid, 'Bitcoin prevout transaction mismatch');
        const prevDecoded = decodeBitcoin(previous.hex);
        same(prevDecoded.txid, input.txid, 'Bitcoin prevout raw hash mismatch');
        validateBitcoinOutputs(previous, prevDecoded);
        const value = prevDecoded.outputs[input.vout];
        const metadata = previous.vout.find((vout) => vout.n === input.vout);
        if (!value || !metadata) mismatch('missing Bitcoin prevout');
        inputs += value.amount;
        const address = bitcoinOutputAddress(metadata);
        if (address) {
          addresses.add(address);
          spentInputs.push({ address, amount: value.amount.toString(), outpoint });
        }
      }
      const outputs = decoded.outputs.reduce((sum, value) => sum + value.amount, 0n);
      if (outputs > inputs) mismatch('Bitcoin outputs exceed inputs');
      output.fee = { asset: native(signal), amount: (inputs - outputs).toString() };
      output.spentAddresses = [...addresses];
      output.spentInputs = spentInputs;
      if (addresses.size === 1) {
        const [source] = addresses;
        output.fee.payer = source;
        output.transfers.forEach((transfer) => {
          transfer.from = source;
        });
      }
    }
    if (output.blockHash) {
      const checked = bitcoinHeader.parse(
        await this.rpc.call(signal.chain, 'getblockheader', [output.blockHash, true]),
      );
      if (
        checked.confirmations < 0 ||
        btcHash.parse(await this.rpc.call(signal.chain, 'getblockhash', [checked.height])) !==
          output.blockHash
      )
        return { ...output, state: 'reverted', transfers: [], fee: undefined, spentAddresses: [] };
    }
    return { ...output, transfersComplete: !!output.blockHash };
  }

  private async verifySolana(
    signal: ExchangeDiscoverySignal,
  ): Promise<VerifiedExchangeTransaction> {
    signature.parse(signal.transactionHash);
    const output = result(signal);
    const raw = await this.rpc.call(signal.chain, 'getTransaction', [
      signal.transactionHash,
      { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (raw === null) return output;
    const tx = solanaTransaction.parse(raw);
    same(tx.transaction.signatures[0], signal.transactionHash, 'Solana signature mismatch');
    const blockRaw = await this.rpc.call(signal.chain, 'getBlock', [
      tx.slot,
      {
        commitment: 'finalized',
        transactionDetails: 'signatures',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (blockRaw === null) return output;
    const block = z
      .object({ blockhash: solAddress, signatures: z.array(signature) })
      .parse(blockRaw);
    if (!block.signatures.includes(signal.transactionHash)) return { ...output, state: 'reverted' };
    output.state = tx.meta.err === null ? 'finalized' : 'failed';
    output.blockHash = block.blockhash;
    output.blockHeight = tx.slot.toString();
    const keys = tx.transaction.message.accountKeys.map((key) =>
      typeof key === 'string' ? key : key.pubkey,
    );
    if (!keys.length) mismatch('Solana payer missing');
    output.fee = { asset: native(signal), amount: units(tx.meta.fee), payer: keys[0] };
    output.spentAddresses = [keys[0]];
    if (tx.meta.err !== null) return { ...output, transfersComplete: true };
    const tokenAccounts = new Map<
      string,
      {
        address: string;
        owner: string;
        mint: string;
        programId: string;
        decimals?: number;
        preAmount?: string;
        postAmount?: string;
      }
    >();
    for (const balance of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
      const address = keys[balance.accountIndex];
      if (!address || !balance.owner || !balance.programId)
        mismatch('incomplete token account identity');
      const entry = {
        address,
        owner: balance.owner,
        mint: balance.mint,
        programId: balance.programId,
        ...(balance.uiTokenAmount ? { decimals: balance.uiTokenAmount.decimals } : {}),
      };
      const existing = tokenAccounts.get(address);
      if (
        existing &&
        (existing.owner !== entry.owner ||
          existing.mint !== entry.mint ||
          existing.programId !== entry.programId ||
          (existing.decimals !== undefined &&
            entry.decimals !== undefined &&
            existing.decimals !== entry.decimals))
      )
        mismatch('token account identity changed during transaction');
      tokenAccounts.set(address, entry);
    }
    for (const entry of tokenAccounts.values()) {
      const index = keys.indexOf(entry.address);
      const pre = tx.meta.preTokenBalances.find((b) => b.accountIndex === index),
        post = tx.meta.postTokenBalances.find((b) => b.accountIndex === index);
      entry.preAmount = pre?.uiTokenAmount?.amount ?? (pre ? undefined : '0');
      entry.postAmount = post?.uiTokenAmount?.amount ?? (post ? undefined : '0');
    }
    output.tokenAccounts = [...tokenAccounts.values()];
    let transfersComplete = true;
    const parseInstruction = (rawInstruction: unknown, outer: number, inner?: number) => {
      const instruction = z
        .object({ programId: solAddress, parsed: z.unknown().optional() })
        .parse(rawInstruction);
      const where =
        inner === undefined ? `instruction:${outer}` : `instruction:${outer}:inner:${inner}`;
      if (NONMOVING_SOL_PROGRAMS.has(instruction.programId)) return;
      if (
        ![SYSTEM_PROGRAM, CLASSIC_SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(
          instruction.programId,
        )
      ) {
        // A program can change its own accounts' lamports without invoking a
        // System transfer. Retain known transfers without asserting that these
        // parsed instructions describe every native movement.
        transfersComplete = false;
        return;
      }
      if (instruction.parsed === undefined) mismatch('unparsed supported Solana instruction');
      const parsed = z
        .object({ type: z.string(), info: z.record(z.string(), z.unknown()) })
        .parse(instruction.parsed);
      if (instruction.programId === SYSTEM_PROGRAM) {
        const nonmoving = [
          'assign',
          'assignWithSeed',
          'allocate',
          'allocateWithSeed',
          'advanceNonce',
          'initializeNonce',
          'authorizeNonce',
          'upgradeNonce',
        ];
        if (nonmoving.includes(parsed.type)) return;
        const creation = [
          'createAccount',
          'createAccountWithSeed',
          'createAccountAllowPrefund',
        ].includes(parsed.type);
        if (
          !creation &&
          !['transfer', 'transferWithSeed', 'withdrawFromNonce'].includes(parsed.type)
        )
          mismatch('unsupported System Program lamport movement');
        if (
          parsed.type === 'createAccountAllowPrefund' &&
          parsed.info.lamports === undefined &&
          parsed.info.source === undefined
        )
          return; // This form adopts a prefunded account without moving lamports.
        const info = z
          .object({
            source: solAddress,
            destination: solAddress,
            lamports: z.unknown(),
            owner: solAddress.optional(),
          })
          .parse({
            ...parsed.info,
            source:
              parsed.type === 'withdrawFromNonce' ? parsed.info.nonceAccount : parsed.info.source,
            destination: creation ? parsed.info.newAccount : parsed.info.destination,
          });
        const amount = units(info.lamports);
        if (BigInt(amount) > 0n)
          output.transfers.push({
            identity: {
              kind: 'solana.instruction',
              id: `${signal.transactionHash}:${where}:native`,
            },
            from: info.source,
            to: info.destination,
            asset: native(signal),
            amount,
            ...(creation && info.owner ? { destinationOwnerProgram: info.owner } : {}),
          });
        return;
      }
      if (!['transfer', 'transferChecked'].includes(parsed.type)) {
        // Token account closure can refund native rent. Exact frame attribution
        // for this and other token lifecycle instructions requires certification.
        transfersComplete = false;
        return;
      }
      if (instruction.programId !== CLASSIC_SPL_TOKEN_PROGRAM)
        mismatch('uncertified Token-2022 transfer');
      const info = z
        .object({
          source: solAddress,
          destination: solAddress,
          mint: solAddress.optional(),
          amount: uint.optional(),
          tokenAmount: z.object({ amount: uint }).optional(),
        })
        .parse(parsed.info);
      const source = tokenAccounts.get(info.source);
      const destination = tokenAccounts.get(info.destination);
      if (!source || !destination) mismatch('SPL transfer account metadata missing');
      same(source.mint, destination.mint, 'SPL mint mismatch');
      same(source.programId, CLASSIC_SPL_TOKEN_PROGRAM, 'SPL source program mismatch');
      same(destination.programId, CLASSIC_SPL_TOKEN_PROGRAM, 'SPL destination program mismatch');
      if (info.mint) same(info.mint, source.mint, 'SPL checked mint mismatch');
      const amount = parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
      if (amount === undefined) mismatch('SPL raw amount missing');
      const assetId = `token:solana:spl:${CLASSIC_SPL_TOKEN_PROGRAM}:${source.mint}`;
      if (BigInt(amount) > 0n)
        output.transfers.push({
          identity: {
            kind: 'solana.instruction',
            id: `${signal.transactionHash}:${where}:${assetId}`,
          },
          from: info.source,
          to: info.destination,
          asset: { ...native(signal), assetId },
          amount,
        });
    };
    tx.transaction.message.instructions.forEach((instruction, index) =>
      parseInstruction(instruction, index),
    );
    const innerPositions = new Set<number>();
    const recordedInner = (tx.meta.innerInstructions ?? []).some(
      (inner) => inner.instructions.length > 0,
    );
    if (recordedInner && !tx.meta.logMessages) mismatch('Solana CPI execution logs missing');
    if (
      recordedInner &&
      tx.meta.logMessages?.some((line) => /^Program [1-9A-HJ-NP-Za-km-z]+ failed:/.test(line))
    )
      mismatch('failed Solana CPI needs certified frame attribution');
    for (const inner of tx.meta.innerInstructions ?? []) {
      if (
        inner.index >= tx.transaction.message.instructions.length ||
        innerPositions.has(inner.index)
      )
        mismatch('invalid Solana inner instruction position');
      innerPositions.add(inner.index);
      inner.instructions.forEach((instruction, index) =>
        parseInstruction(instruction, inner.index, index),
      );
    }
    // A registered pubkey can be assigned to a program. Finalized lamports at
    // that pubkey are not necessarily spendable by its private key. Resolve
    // ownership independently of provider hints and pin the RPC context floor.
    const owners = new Map<string, string | undefined>();
    for (const transfer of output.transfers.filter(
      (transfer) => transfer.asset.assetId === native(signal).assetId,
    )) {
      if (!owners.has(transfer.to)) {
        const account = z
          .object({
            context: z.object({ slot: integer }),
            value: z.object({ owner: solAddress }).nullable(),
          })
          .parse(
            await this.rpc.call(signal.chain, 'getAccountInfo', [
              transfer.to,
              { commitment: 'finalized', encoding: 'base64', minContextSlot: tx.slot },
            ]),
          );
        if (account.context.slot < tx.slot)
          mismatch('Solana account ownership context predates transaction');
        owners.set(transfer.to, account.value?.owner);
      }
      transfer.destinationOwnerProgram = owners.get(transfer.to);
    }
    return { ...output, transfersComplete };
  }
}

const bitcoinRpcTransaction = z.object({
  txid: btcHash,
  hex: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{2})+$/)
    .max(8_000_000),
  blockhash: btcHash.optional(),
  vout: z.array(
    z.object({
      n: integer,
      scriptPubKey: z.object({
        hex: z.string().regex(/^(?:[0-9a-fA-F]{2})*$/),
        address: z.string().min(1).optional(),
        addresses: z.array(z.string().min(1)).optional(),
      }),
    }),
  ),
});
const bitcoinHeader = z.object({
  hash: btcHash,
  height: integer,
  confirmations: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
});

function bitcoinOutputAddress(output: z.infer<typeof bitcoinRpcTransaction>['vout'][number]) {
  if (output.scriptPubKey.address) return output.scriptPubKey.address;
  if (output.scriptPubKey.addresses?.length === 1) return output.scriptPubKey.addresses[0];
  // Bare multisig/non-address outputs are custody exceptions, not arbitrary owners.
  return undefined;
}

interface DecodedBitcoin {
  txid: string;
  coinbase: boolean;
  inputs: { txid: string; vout: number }[];
  outputs: { amount: bigint; script: string }[];
}

function validateBitcoinOutputs(
  rpc: z.infer<typeof bitcoinRpcTransaction>,
  decoded: DecodedBitcoin,
) {
  if (rpc.vout.length !== decoded.outputs.length) mismatch('Bitcoin output count mismatch');
  const indexes = new Set<number>();
  for (const output of rpc.vout) {
    if (indexes.has(output.n) || !decoded.outputs[output.n])
      mismatch('invalid Bitcoin output position');
    indexes.add(output.n);
    same(
      output.scriptPubKey.hex.toLowerCase(),
      decoded.outputs[output.n].script,
      'Bitcoin output script mismatch',
    );
  }
}

// Decode wire values rather than converting the RPC's JSON BTC floating numbers.
function decodeBitcoin(hex: string): DecodedBitcoin {
  const bytes = Buffer.from(hex, 'hex');
  let offset = 0;
  const read = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length)
      mismatch('truncated Bitcoin transaction');
    const value = bytes.subarray(offset, offset + count);
    offset += count;
    return value;
  };
  const compact = () => {
    const marker = read(1)[0];
    const value =
      marker < 253
        ? BigInt(marker)
        : marker === 253
          ? BigInt(read(2).readUInt16LE())
          : marker === 254
            ? BigInt(read(4).readUInt32LE())
            : read(8).readBigUInt64LE();
    if (value > BigInt(bytes.length)) mismatch('oversized Bitcoin vector');
    return Number(value);
  };
  const version = read(4);
  const segwit = bytes[offset] === 0;
  if (segwit) {
    read(1);
    if (read(1)[0] !== 1) mismatch('unsupported Bitcoin witness flag');
  }
  const inputStart = offset;
  const count = compact();
  if (count === 0) mismatch('Bitcoin inputs missing');
  const inputs: DecodedBitcoin['inputs'] = [];
  for (let index = 0; index < count; index++) {
    const txid = Buffer.from(read(32)).reverse().toString('hex');
    const vout = read(4).readUInt32LE();
    read(compact());
    read(4);
    inputs.push({ txid, vout });
  }
  const outputCount = compact();
  const outputs: DecodedBitcoin['outputs'] = [];
  for (let index = 0; index < outputCount; index++) {
    const amount = read(8).readBigUInt64LE();
    if (amount > 2_100_000_000_000_000n) mismatch('Bitcoin amount exceeds supply');
    outputs.push({ amount, script: read(compact()).toString('hex') });
  }
  const outputEnd = offset;
  if (segwit)
    for (let index = 0; index < count; index++) {
      const stack = compact();
      for (let item = 0; item < stack; item++) read(compact());
    }
  const locktime = read(4);
  if (offset !== bytes.length) mismatch('Bitcoin trailing data');
  const serialization = Buffer.concat([version, bytes.subarray(inputStart, outputEnd), locktime]);
  const digest = createHash('sha256')
    .update(createHash('sha256').update(serialization).digest())
    .digest();
  return {
    txid: digest.reverse().toString('hex'),
    inputs,
    outputs,
    coinbase:
      inputs.length === 1 && inputs[0].txid === '0'.repeat(64) && inputs[0].vout === 0xffffffff,
  };
}

const tokenBalance = z.object({
  accountIndex: integer,
  mint: solAddress,
  owner: solAddress.optional(),
  programId: solAddress.optional(),
  uiTokenAmount: z.object({ amount: uint, decimals: integer.max(18) }).optional(),
});
const solanaTransaction = z.object({
  slot: integer,
  transaction: z.object({
    signatures: z.array(signature).min(1),
    message: z.object({
      accountKeys: z.array(z.union([solAddress, z.object({ pubkey: solAddress })])),
      instructions: z.array(z.unknown()),
    }),
  }),
  meta: z
    .object({
      err: z.unknown(),
      fee: z.unknown(),
      innerInstructions: z
        .array(z.object({ index: integer, instructions: z.array(z.unknown()) }))
        .nullable(),
      logMessages: z.array(z.string()).nullable().optional(),
      preTokenBalances: z.array(tokenBalance),
      postTokenBalances: z.array(tokenBalance),
    })
    .refine((meta) => Object.hasOwn(meta, 'err'), 'Solana execution result missing'),
});
