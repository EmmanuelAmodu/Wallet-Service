import { BadGatewayException, Injectable } from '@nestjs/common';
import { keccak256 } from 'ethers';
import { z } from 'zod';
import { ChainRpcService } from './chain-rpc.service.js';
import { TokenPreparation, validateTokenPreparation } from './token-planner.js';
import { verifySignedErc20Transfer, verifySignedSplTransfer } from './token-encoding.js';
import { SignedTransaction } from '../../shared/src/contracts.js';
import { CLASSIC_TOKEN_PROGRAM } from '../../shared/src/token-contracts.js';
import { getWalletCore } from './coin-metadata.js';

const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase());
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((v) => BigInt(v) < 1n << 64n);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export interface TokenObservation {
  state: 'pending' | 'confirmed' | 'failed' | 'reverted';
  blockHash?: string;
  blockHeight?: string;
  actualFeeUnits?: string;
  actualRentUnits?: string;
  feePayerAddress?: string;
}

function evidence(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new BadGatewayException('Token canonical evidence mismatch: ' + reason);
}

/** Exact signed bytes and canonical execution evidence; absence is pending, never safe failure. */
@Injectable()
export class TokenObserver {
  constructor(private readonly rpc: ChainRpcService) {}

  async observe(
    prepared: TokenPreparation,
    signed: SignedTransaction,
    priorInclusion?: { blockHash: string; blockHeight: string },
  ): Promise<TokenObservation> {
    validateTokenPreparation(prepared);
    evidence(
      this.rpc.networkIdentity(prepared.certificate.chain) === prepared.certificate.network,
      'pinned network',
    );
    await this.rpc.verifyNetwork(prepared.certificate.chain);
    if (priorInclusion) {
      if (prepared.certificate.chain === 'ethereum') {
        const block = z
          .object({ hash })
          .nullable()
          .parse(
            await this.rpc.call('ethereum', 'eth_getBlockByNumber', [
              '0x' + BigInt(priorInclusion.blockHeight).toString(16),
              false,
            ]),
          );
        if (block === null)
          throw new BadGatewayException('Prior token inclusion block unavailable');
        if (block.hash !== priorInclusion.blockHash.toLowerCase()) return { state: 'reverted' };
      } else {
        const slot = Number(priorInclusion.blockHeight);
        evidence(Number.isSafeInteger(slot) && slot >= 0, 'prior slot');
        const block = z
          .object({ blockhash: z.string() })
          .nullable()
          .parse(
            await this.rpc.call('solana', 'getBlock', [
              slot,
              { commitment: 'finalized', transactionDetails: 'none', rewards: false },
            ]),
          );
        if (block === null)
          throw new BadGatewayException('Prior token inclusion block unavailable');
        if (block.blockhash !== priorInclusion.blockHash) return { state: 'reverted' };
      }
    }
    return prepared.request.transaction.kind === 'erc20'
      ? this.ethereum(prepared, signed)
      : this.solana(prepared, signed);
  }

  private async ethereum(
    prepared: TokenPreparation,
    signed: SignedTransaction,
  ): Promise<TokenObservation> {
    const tx = prepared.request.transaction,
      c = prepared.certificate;
    if (tx.kind !== 'erc20' || c.standard !== 'erc20') throw new Error('Token adapter mismatch');
    const decoded = verifySignedErc20Transfer(prepared.request, signed);
    const raw = await this.rpc.call('ethereum', 'eth_getTransactionReceipt', [signed.txHash]);
    if (raw === null) return { state: 'pending' };
    const receipt = z
      .object({
        transactionHash: hash,
        blockHash: hash,
        blockNumber: quantity,
        status: z.enum(['0x0', '0x1']),
        gasUsed: quantity,
        effectiveGasPrice: quantity,
        logs: z.array(
          z.object({
            address: z.string(),
            topics: z.array(hash),
            data: z.string(),
            removed: z.boolean().optional(),
            transactionHash: hash,
            blockHash: hash,
            logIndex: quantity,
          }),
        ),
      })
      .parse(raw);
    evidence(receipt.transactionHash === signed.txHash, 'receipt transaction');
    const chainTx = z
      .object({
        hash,
        from: z.string(),
        to: z.string(),
        value: quantity,
        nonce: quantity,
        input: z.string(),
        blockHash: hash,
        blockNumber: quantity,
      })
      .parse(await this.rpc.call('ethereum', 'eth_getTransactionByHash', [signed.txHash]));
    evidence(
      chainTx.hash === signed.txHash &&
        chainTx.from.toLowerCase() === decoded.from?.toLowerCase() &&
        chainTx.to.toLowerCase() === tx.contract &&
        BigInt(chainTx.value) === 0n &&
        BigInt(chainTx.nonce).toString() === tx.nonce &&
        chainTx.input.toLowerCase() === decoded.data &&
        chainTx.blockHash === receipt.blockHash &&
        chainTx.blockNumber === receipt.blockNumber,
      'exact included transfer',
    );
    const lookup = async () =>
      z
        .object({ hash, number: quantity, transactions: z.array(hash) })
        .nullable()
        .parse(
          await this.rpc.call('ethereum', 'eth_getBlockByNumber', [receipt.blockNumber, false]),
        );
    const canonical = await lookup();
    if (canonical === null) throw new BadGatewayException('Canonical token block unavailable');
    evidence(canonical.number === receipt.blockNumber, 'canonical height');
    if (canonical.hash !== receipt.blockHash || !canonical.transactions.includes(signed.txHash))
      return { state: 'reverted' };
    const code = await this.rpc.call('ethereum', 'eth_getCode', [c.contract, receipt.blockNumber]);
    evidence(
      typeof code === 'string' &&
        /^0x(?:[0-9a-fA-F]{2})+$/.test(code) &&
        keccak256(code) === c.runtimeCodeHash,
      'included token code certification',
    );
    const gas = BigInt(receipt.gasUsed),
      price = BigInt(receipt.effectiveGasPrice),
      fee = gas * price;
    evidence(
      gas > 0n &&
        gas <= BigInt(tx.gasLimit) &&
        price <= BigInt(tx.maxFeePerGas) &&
        fee <= BigInt(prepared.maxFeeUnits),
      'actual native fees',
    );
    if (receipt.status === '0x1') {
      const transfers = receipt.logs.filter(
        (log) => log.address.toLowerCase() === c.contract && log.topics[0] === TRANSFER,
      );
      evidence(transfers.length === 1, 'exact-transfer token semantics');
      const log = transfers[0];
      evidence(
        !log.removed &&
          log.transactionHash === signed.txHash &&
          log.blockHash === receipt.blockHash &&
          log.topics.length === 3 &&
          log.topics[1] ===
            '0x' + prepared.request.wallet.address.slice(2).toLowerCase().padStart(64, '0') &&
          log.topics[2] === '0x' + tx.recipient.slice(2).padStart(64, '0') &&
          /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
          BigInt(log.data).toString() === tx.amount,
        'canonical token recipient and principal',
      );
    }
    const finalized = z
      .object({ hash, number: quantity })
      .parse(await this.rpc.call('ethereum', 'eth_getBlockByNumber', ['finalized', false]));
    const checked = await lookup();
    if (checked === null) throw new BadGatewayException('Canonical token block unavailable');
    if (checked.hash !== receipt.blockHash || !checked.transactions.includes(signed.txHash))
      return { state: 'reverted' };
    return {
      state:
        BigInt(receipt.blockNumber) > BigInt(finalized.number)
          ? 'pending'
          : receipt.status === '0x1'
            ? 'confirmed'
            : 'failed',
      blockHash: receipt.blockHash,
      blockHeight: BigInt(receipt.blockNumber).toString(),
      actualFeeUnits: fee.toString(),
      actualRentUnits: '0',
      feePayerAddress: prepared.request.wallet.address,
    };
  }

  private async solana(
    prepared: TokenPreparation,
    signed: SignedTransaction,
  ): Promise<TokenObservation> {
    const tx = prepared.request.transaction;
    if (tx.kind !== 'spl') throw new Error('Token adapter mismatch');
    const decoded = await verifySignedSplTransfer(prepared.request, signed);
    const raw = await this.rpc.call('solana', 'getTransaction', [
      signed.txHash,
      { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 },
    ]);
    if (raw === null) return { state: 'pending' };
    const balance = z.object({
      accountIndex: safe,
      mint: z.string(),
      owner: z.string(),
      programId: z.string(),
      uiTokenAmount: z.object({ amount: tokenUnits, decimals: safe }),
    });
    const result = z
      .object({
        slot: safe,
        transaction: z.tuple([z.string(), z.literal('base64')]),
        meta: z.object({
          err: z.union([
            z.null(),
            z.string().min(1),
            z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0),
          ]),
          fee: safe,
          preBalances: z.array(safe),
          postBalances: z.array(safe),
          preTokenBalances: z.array(balance),
          postTokenBalances: z.array(balance),
        }),
      })
      .parse(raw);
    evidence(result.transaction[0] === signed.raw, 'canonical signed SPL bytes');
    evidence(
      BigInt(result.meta.fee) <= BigInt(prepared.maxFeeUnits) && result.meta.fee > 0,
      'SPL fee bound',
    );
    evidence(
      result.meta.preBalances.length === decoded.keys.length &&
        result.meta.postBalances.length === decoded.keys.length,
      'canonical native balance vector',
    );
    const core = await getWalletCore(),
      keys = decoded.keys.map((key) => core.Base58.encodeNoCheck(key));
    const sourceIndex = keys.indexOf(tx.sourceTokenAccount),
      targetIndex = keys.indexOf(tx.recipientTokenAccount);
    let rent = 0n;
    if (result.meta.err === null) {
      for (const entries of [result.meta.preTokenBalances, result.meta.postTokenBalances]) {
        evidence(
          new Set(entries.map((entry) => entry.accountIndex)).size === entries.length,
          'unique token balance accounts',
        );
        for (const entry of entries)
          evidence(
            [sourceIndex, targetIndex].includes(entry.accountIndex) &&
              entry.mint === tx.mint &&
              entry.programId === CLASSIC_TOKEN_PROGRAM &&
              entry.uiTokenAmount.decimals === tx.decimals &&
              entry.owner ===
                (entry.accountIndex === sourceIndex
                  ? prepared.request.wallet.address
                  : tx.recipientOwner),
            'canonical SPL owner, mint, program and precision',
          );
      }
      const preSource = result.meta.preTokenBalances.find(
        (entry) => entry.accountIndex === sourceIndex,
      );
      const postSource = result.meta.postTokenBalances.find(
        (entry) => entry.accountIndex === sourceIndex,
      );
      const preTarget = result.meta.preTokenBalances.find(
        (entry) => entry.accountIndex === targetIndex,
      );
      const postTarget = result.meta.postTokenBalances.find(
        (entry) => entry.accountIndex === targetIndex,
      );
      evidence(
        !!preSource &&
          !!postSource &&
          !!postTarget &&
          (tx.createRecipientAccount ? !preTarget : !!preTarget),
        'retained source and target token accounts',
      );
      evidence(
        BigInt(preSource.uiTokenAmount.amount) - BigInt(postSource.uiTokenAmount.amount) ===
          BigInt(tx.amount) &&
          BigInt(postTarget.uiTokenAmount.amount) -
            BigInt(preTarget?.uiTokenAmount.amount ?? '0') ===
            BigInt(tx.amount),
        'exact SPL principal deltas',
      );
      if (tx.createRecipientAccount) {
        evidence(
          result.meta.preBalances[targetIndex] === 0,
          'new associated account was not already funded',
        );
        rent = BigInt(result.meta.postBalances[targetIndex]);
        evidence(rent > 0n && rent <= BigInt(prepared.rentUnits), 'actual associated account rent');
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const change = BigInt(result.meta.postBalances[i]) - BigInt(result.meta.preBalances[i]);
      const expected =
        i === 0
          ? -BigInt(result.meta.fee) - rent
          : result.meta.err === null && tx.createRecipientAccount && i === targetIndex
            ? rent
            : 0n;
      evidence(change === expected, 'native fee payer and rent movements');
    }
    const lookup = async () =>
      z
        .object({ blockhash: z.string(), signatures: z.array(z.string()) })
        .nullable()
        .parse(
          await this.rpc.call('solana', 'getBlock', [
            result.slot,
            {
              commitment: 'finalized',
              transactionDetails: 'signatures',
              rewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ]),
        );
    const block = await lookup();
    if (block === null) throw new BadGatewayException('Canonical SPL block unavailable');
    if (!block.signatures.includes(signed.txHash)) return { state: 'reverted' };
    const checked = await lookup();
    if (checked === null) throw new BadGatewayException('Canonical SPL block unavailable');
    if (checked.blockhash !== block.blockhash || !checked.signatures.includes(signed.txHash))
      return { state: 'reverted' };
    return {
      state: result.meta.err === null ? 'confirmed' : 'failed',
      blockHash: block.blockhash,
      blockHeight: result.slot.toString(),
      actualFeeUnits: result.meta.fee.toString(),
      actualRentUnits: rent.toString(),
      feePayerAddress: tx.feePayer.address,
    };
  }
}
