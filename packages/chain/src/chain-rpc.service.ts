import { Inject, Injectable, BadGatewayException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Chain,
  chainFamily,
  isBitcoinChain,
  isEvmChain,
  isSolanaChain,
  SignRequest,
  SignedTransaction,
  Transfer,
} from '../../shared/src/contracts.js';

import { ChainNetworkMap, ChainNetworkSettings, networkConfig } from './config.js';

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
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
export class RpcFailure extends BadGatewayException {
  constructor(readonly rpcCode?: number) {
    super('Blockchain RPC operation failed');
  }
}
@Injectable()
export class ChainRpcService {
  constructor(@Inject(networkConfig.KEY) private readonly config: NetworkConfig) {}

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

  async prepare(address: string, transfer: Transfer): Promise<SignRequest['transaction']> {
    await this.verifyNetwork(transfer.chain);
    if ('to' in transfer) {
      const nonce = hex.parse(
        await this.call('ethereum', 'eth_getTransactionCount', [address, 'pending']),
      );
      if (BigInt(transfer.maxPriorityFeePerGas) > BigInt(transfer.maxFeePerGas))
        throw new BadRequestException('Priority fee exceeds max fee');
      const gas = hex.parse(
        await this.call('ethereum', 'eth_estimateGas', [
          {
            from: address,
            to: transfer.to,
            value: '0x' + BigInt(transfer.amount).toString(16),
            maxFeePerGas: '0x' + BigInt(transfer.maxFeePerGas).toString(16),
            maxPriorityFeePerGas: '0x' + BigInt(transfer.maxPriorityFeePerGas).toString(16),
          },
        ]),
      );
      // Bounded headroom for recipient contracts; no arbitrary calldata in v1.
      const gasLimit = ((BigInt(gas) * 120n) / 100n).toString();
      const balance = hex.parse(
        await this.call('ethereum', 'eth_getBalance', [address, 'pending']),
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
    if ('utxos' in transfer) {
      if (new Set(transfer.utxos.map((u) => `${u.txid}:${u.vout}`)).size !== transfer.utxos.length)
        throw new BadRequestException('Duplicate UTXO');
      const utxos = [];
      for (const ref of transfer.utxos) {
        const result = await this.call('bitcoin', 'gettxout', [ref.txid, ref.vout, true]);
        if (result === null) throw new BadRequestException('UTXO is unavailable or already spent');
        const u = z
          .object({
            value: z.number().positive(),
            confirmations: z.number().int(),
            coinbase: z.boolean(),
            scriptPubKey: z.object({ hex: z.string().regex(/^[0-9a-f]+$/), address: z.string() }),
          })
          .parse(result);
        if (
          u.scriptPubKey.address !== address ||
          u.confirmations < 1 ||
          (u.coinbase && u.confirmations < 100)
        )
          throw new BadRequestException('UTXO must be confirmed, mature, and owned by this wallet');
        const amount = u.value
          .toFixed(8)
          .replace('.', '')
          .replace(/^0+(?=\d)/, '');
        utxos.push({ ...ref, amount, script: u.scriptPubKey.hex });
      }
      return { ...transfer, utxos };
    }
    const result = z
      .object({
        value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number().int() }),
      })
      .parse(await this.call('solana', 'getLatestBlockhash', [{ commitment: 'finalized' }]));
    return {
      ...transfer,
      recentBlockhash: result.value.blockhash,
      lastValidBlockHeight: result.value.lastValidBlockHeight,
    };
  }

  async preflight(chain: Chain, signed: SignedTransaction) {
    if (!isSolanaChain(chain)) return;
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
}
