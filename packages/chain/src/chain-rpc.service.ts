import { Inject, Injectable, BadGatewayException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Chain,
  chainFamily,
  isBitcoinChain,
  isEvmChain,
  isSolanaChain,
  BitcoinChain,
  EvmChain,
  SolanaChain,
  SignRequest,
  SignedTransaction,
  Transfer,
} from '../../shared/src/contracts.js';

import { ChainNetworkMap, ChainNetworkSettings, networkConfig } from './config.js';
import { regtestWitnessAddress } from './bitcoin-address.js';
import { assertEvmExternalAddress, assertSolanaExternalAddress } from './recipient-policy.js';
import { Transaction } from 'ethers';
import { getWalletCore } from './coin-metadata.js';
import { decodeLegacySolanaTransaction } from './token-encoding.js';

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
type EvmTransfer = Extract<Transfer, { chain: EvmChain }>;
type BitcoinTransfer = Extract<Transfer, { chain: BitcoinChain }>;
type SolanaTransfer = Extract<Transfer, { chain: SolanaChain }>;
type EvmTransaction = Extract<SignRequest['transaction'], { chain: EvmChain }>;
type BitcoinTransaction = Extract<SignRequest['transaction'], { chain: BitcoinChain }>;
type SolanaTransaction = Extract<SignRequest['transaction'], { chain: SolanaChain }>;

export interface NetworkConfig {
  ethereumUrl?: string;
  ethereumChainId: string;
  bitcoinUrl?: string;
  bitcoinUser?: string;
  bitcoinPassword?: string;
  solanaUrl?: string;
  solanaGenesisHash: string;
  chainNetworks?: ChainNetworkMap;
}

export interface ChainObservation {
  state: 'observed' | 'finalized' | 'failed' | 'reverted';
  transactionFound?: boolean;
  blockHash?: string;
  blockHeight?: string;
  feeAmount?: string;
}

export class RpcFailure extends BadGatewayException {
  constructor(readonly rpcCode?: number) {
    super('Blockchain RPC operation failed');
  }
}

@Injectable()
export class ChainRpcService {
  constructor(@Inject(networkConfig.KEY) private readonly config: NetworkConfig) {}

  networkIdentity(chain: Chain) {
    return this.networkSettings(chain).network;
  }

  protected networkSettings(chain: Chain): ChainNetworkSettings {
    const configured = this.config.chainNetworks?.[chain];
    if (configured) return configured;
    const family = chainFamily(chain);
    if (family === 'ethereum' && chain === 'ethereum')
      return {
        network: this.config.ethereumChainId,
        chainId: this.config.ethereumChainId,
        rpcUrl: this.config.ethereumUrl,
      };
    if (family === 'bitcoin' && chain === 'bitcoin')
      return {
        network: 'mainnet',
        rpcNetwork: 'main',
        rpcUrl: this.config.bitcoinUrl,
        rpcUser: this.config.bitcoinUser,
        rpcPassword: this.config.bitcoinPassword,
        confirmations: 6,
      };
    if (family === 'solana' && chain === 'solana')
      return {
        network: this.config.solanaGenesisHash,
        genesisHash: this.config.solanaGenesisHash,
        rpcUrl: this.config.solanaUrl,
      };
    throw new BadRequestException(`${chain} network is not configured`);
  }

  async call(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
    const settings = this.networkSettings(chain);
    const family = chainFamily(chain);
    const url = settings.rpcUrl;
    if (!url) throw new BadRequestException(`${chain} RPC is not configured`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const rpcUser = settings.rpcUser ?? (chain === 'bitcoin' ? this.config.bitcoinUser : undefined);
    const rpcPassword =
      settings.rpcPassword ?? (chain === 'bitcoin' ? this.config.bitcoinPassword : undefined);
    if (family === 'bitcoin' && rpcUser)
      headers.authorization =
        'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword ?? ''}`).toString('base64');
    try {
      const id = randomUUID();
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = z
        .object({ id: z.string(), result: z.unknown().optional(), error: z.unknown().optional() })
        .parse(await response.json());
      if (body.id !== id) throw new RpcFailure();
      if (body.error) {
        const error = z.object({ code: z.number() }).safeParse(body.error);
        throw new RpcFailure(error.success ? error.data.code : undefined);
      }
      if (!response.ok) throw new RpcFailure();
      return body.result;
    } catch (error) {
      if (error instanceof RpcFailure) throw error;
      throw new RpcFailure();
    }
  }

  async verifyNetwork(chain: Chain) {
    const settings = this.networkSettings(chain);
    if (isEvmChain(chain)) {
      const id = hex.parse(await this.call(chain, 'eth_chainId', []));
      if (BigInt(id).toString() !== settings.chainId)
        throw new BadGatewayException(`${chain} RPC network mismatch`);
    } else if (isBitcoinChain(chain)) {
      const info = z
        .object({ chain: z.string() })
        .parse(await this.call(chain, 'getblockchaininfo', []));
      if (info.chain !== (settings.rpcNetwork ?? 'main'))
        throw new BadGatewayException(`${chain} RPC network mismatch`);
    } else {
      if ((await this.call(chain, 'getGenesisHash', [])) !== settings.genesisHash)
        throw new BadGatewayException('Solana RPC network mismatch');
    }
  }

  async observeTransaction(chain: Chain, hash: string): Promise<ChainObservation> {
    await this.verifyNetwork(chain);
    const settings = this.networkSettings(chain);
    if (isEvmChain(chain)) {
      const raw = await this.call(chain, 'eth_getTransactionReceipt', [hash]);
      if (raw === null) {
        const transaction = await this.call(chain, 'eth_getTransactionByHash', [hash]);
        return { state: 'observed', transactionFound: transaction !== null };
      }
      const receipt = z
        .object({
          blockHash: z.string(),
          blockNumber: hex,
          status: z.enum(['0x0', '0x1']),
          gasUsed: hex,
          effectiveGasPrice: hex.optional(),
        })
        .parse(raw);
      const head = hex.parse(await this.call(chain, 'eth_blockNumber', []));
      const confirmations = BigInt(head) - BigInt(receipt.blockNumber) + 1n;
      const feeAmount = receipt.effectiveGasPrice
        ? (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString()
        : undefined;
      if (confirmations < BigInt(settings.confirmations ?? 12))
        return {
          state: 'observed',
          transactionFound: true,
          blockHash: receipt.blockHash,
          blockHeight: BigInt(receipt.blockNumber).toString(),
          feeAmount,
        };
      return {
        state: receipt.status === '0x1' ? 'finalized' : 'failed',
        transactionFound: true,
        blockHash: receipt.blockHash,
        blockHeight: BigInt(receipt.blockNumber).toString(),
        feeAmount,
      };
    }
    if (isBitcoinChain(chain)) {
      try {
        const transaction = z
          .object({
            confirmations: z.number().int().optional(),
            blockhash: z.string().optional(),
            blockheight: z.number().int().nonnegative().optional(),
          })
          .parse(await this.call(chain, 'getrawtransaction', [hash, true]));
        if (transaction.confirmations !== undefined && transaction.confirmations < 0)
          return { state: 'reverted' };
        return {
          state:
            (transaction.confirmations ?? 0) >= (settings.confirmations ?? 6)
              ? 'finalized'
              : 'observed',
          transactionFound: true,
          ...(transaction.blockhash ? { blockHash: transaction.blockhash } : {}),
          ...(transaction.blockheight !== undefined
            ? { blockHeight: String(transaction.blockheight) }
            : {}),
        };
      } catch (error) {
        if (error instanceof RpcFailure && error.rpcCode === -5)
          return { state: 'observed', transactionFound: false };
        throw error;
      }
    }

    const result = z
      .object({
        value: z.array(
          z
            .object({
              err: z.unknown(),
              confirmationStatus: z.string().nullable(),
              slot: z.number().int().nonnegative(),
            })
            .nullable(),
        ),
      })
      .parse(
        await this.call(chain, 'getSignatureStatuses', [
          [hash],
          { searchTransactionHistory: true },
        ]),
      );
    const status = result.value[0];
    if (!status) return { state: 'observed', transactionFound: false };
    if (status.confirmationStatus !== 'finalized')
      return { state: 'observed', transactionFound: true, blockHeight: String(status.slot) };
    const block = await this.call(chain, 'getBlock', [
      status.slot,
      { commitment: 'finalized', rewards: false, transactionDetails: 'none' },
    ]);
    const blockHash = z.object({ blockhash: z.string() }).safeParse(block);
    return {
      state: status.err ? 'failed' : 'finalized',
      transactionFound: true,
      blockHeight: String(status.slot),
      ...(blockHash.success ? { blockHash: blockHash.data.blockhash } : {}),
    };
  }

  async prepare(address: string, transfer: Transfer): Promise<SignRequest['transaction']> {
    await this.verifyNetwork(transfer.chain);
    if ('to' in transfer) return this.prepareEvm(address, transfer);
    if ('utxos' in transfer) return this.prepareBitcoin(address, transfer);
    return this.prepareSolana(transfer);
  }

  private async prepareEvm(address: string, transfer: EvmTransfer): Promise<EvmTransaction> {
    await this.assertExternalEvmRecipient(transfer.chain, transfer.to);
    const nonce = hex.parse(
      await this.call(transfer.chain, 'eth_getTransactionCount', [address, 'pending']),
    );
    if (BigInt(transfer.maxPriorityFeePerGas) > BigInt(transfer.maxFeePerGas))
      throw new BadRequestException('Priority fee exceeds max fee');
    const gas = hex.parse(
      await this.call(transfer.chain, 'eth_estimateGas', [
        {
          from: address,
          to: transfer.to,
          value: '0x' + BigInt(transfer.amount).toString(16),
          maxFeePerGas: '0x' + BigInt(transfer.maxFeePerGas).toString(16),
          maxPriorityFeePerGas: '0x' + BigInt(transfer.maxPriorityFeePerGas).toString(16),
        },
      ]),
    );
    // Bounded headroom; recipients with deployed or delegated code are excluded.
    const gasLimit = ((BigInt(gas) * 120n) / 100n).toString();
    const balance = hex.parse(
      await this.call(transfer.chain, 'eth_getBalance', [address, 'pending']),
    );
    if (
      BigInt(balance) <
      BigInt(transfer.amount) + BigInt(gasLimit) * BigInt(transfer.maxFeePerGas)
    )
      throw new BadRequestException('Insufficient ETH for value and maximum fee');
    return {
      ...transfer,
      chainId: this.networkSettings(transfer.chain).chainId!,
      nonce: BigInt(nonce).toString(),
      gasLimit,
    };
  }

  private async prepareBitcoin(
    address: string,
    transfer: BitcoinTransfer,
  ): Promise<BitcoinTransaction> {
    if (
      transfer.chain === 'bitcoin' &&
      this.networkSettings(transfer.chain).network === 'regtest'
    ) {
      if (regtestWitnessAddress(address).address !== address)
        throw new BadRequestException('Bitcoin source address must be canonical');
      for (const output of transfer.outputs) regtestWitnessAddress(output.address);
    }
    if (new Set(transfer.utxos.map((u) => `${u.txid}:${u.vout}`)).size !== transfer.utxos.length)
      throw new BadRequestException('Duplicate UTXO');
    const utxos: BitcoinTransaction['utxos'] = [];
    for (const ref of transfer.utxos) {
      const result = await this.call(transfer.chain, 'gettxout', [ref.txid, ref.vout, true]);
      if (result === null) throw new BadRequestException('UTXO is unavailable or already spent');
      const utxo = z
        .object({
          value: z.number().positive(),
          confirmations: z.number().int(),
          coinbase: z.boolean(),
          scriptPubKey: z.object({ hex: z.string().regex(/^[0-9a-f]+$/), address: z.string() }),
        })
        .parse(result);
      if (
        utxo.scriptPubKey.address !== address ||
        utxo.confirmations < 1 ||
        (utxo.coinbase && utxo.confirmations < 100)
      )
        throw new BadRequestException('UTXO must be confirmed, mature, and owned by this wallet');
      const amount = utxo.value
        .toFixed(8)
        .replace('.', '')
        .replace(/^0+(?=\d)/, '');
      utxos.push({ ...ref, amount, script: utxo.scriptPubKey.hex });
    }
    return { ...transfer, utxos };
  }

  private async prepareSolana(transfer: SolanaTransfer): Promise<SolanaTransaction> {
    for (const output of transfer.outputs) await this.assertExternalSolanaRecipient(output.address);
    const result = await this.call('solana', 'getLatestBlockhash', [{ commitment: 'finalized' }]);
    const blockhash = z
      .object({
        value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number().int() }),
      })
      .parse(result).value;
    return {
      ...transfer,
      recentBlockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
  }

  async preflight(chain: Chain, signed: SignedTransaction) {
    if (isEvmChain(chain)) {
      const transaction = Transaction.from(signed.raw);
      if (
        signed.encoding !== 'hex' ||
        !transaction.isSigned() ||
        transaction.hash !== signed.txHash ||
        transaction.data !== '0x' ||
        !transaction.to
      )
        throw new BadRequestException(
          'Only native transfers to external wallets may use this preflight',
        );
      await this.assertExternalEvmRecipient(chain, transaction.to);
      return;
    }
    if (!isSolanaChain(chain)) return;
    if (signed.encoding !== 'base64')
      throw new BadRequestException('Invalid native Solana encoding');
    const packet = decodeLegacySolanaTransaction(signed.raw, 20),
      core = await getWalletCore();
    if (
      packet.requiredSignatures !== 1 ||
      core.Base58.encodeNoCheck(packet.signatures[0]) !== signed.txHash
    )
      throw new BadRequestException('Invalid native Solana signature identity');
    for (const instruction of packet.instructions) {
      if (
        core.Base58.encodeNoCheck(packet.keys[instruction.program]) !==
          '11111111111111111111111111111111' ||
        instruction.accounts.length !== 2 ||
        instruction.accounts[0] !== 0 ||
        instruction.data.length !== 12 ||
        instruction.data.readUInt32LE(0) !== 2
      )
        throw new BadRequestException('Only native System transfers may use this preflight');
      await this.assertExternalSolanaRecipient(
        core.Base58.encodeNoCheck(packet.keys[instruction.accounts[1]]),
      );
    }
    const result = z
      .object({ value: z.object({ err: z.unknown() }) })
      .parse(
        await this.call(chain, 'simulateTransaction', [
          signed.raw,
          { encoding: 'base64', sigVerify: true, commitment: 'finalized' },
        ]),
      );
    if (result.value.err !== null)
      throw new BadRequestException('Solana transfer simulation failed');
  }

  private async assertExternalEvmRecipient(chain: EvmChain, address: string) {
    assertEvmExternalAddress(address);
    const codes = await Promise.all(
      ['finalized', 'pending'].map((tag) => this.call(chain, 'eth_getCode', [address, tag])),
    );
    if (codes.some((code) => code !== '0x'))
      throw new BadRequestException('Recipient must have no contract or delegated code');
  }

  private async assertExternalSolanaRecipient(address: string) {
    await assertSolanaExternalAddress(address);
    const account = z
      .object({
        value: z
          .object({
            owner: z.string(),
            executable: z.boolean(),
            data: z.tuple([z.string(), z.literal('base64')]),
          })
          .nullable(),
      })
      .parse(
        await this.call('solana', 'getAccountInfo', [
          address,
          { commitment: 'finalized', encoding: 'base64' },
        ]),
      );
    if (
      account.value &&
      (account.value.owner !== '11111111111111111111111111111111' ||
        account.value.executable ||
        account.value.data[0] !== '')
    )
      throw new BadRequestException('Solana recipient must be an ordinary System account');
  }
}
