import { BadGatewayException } from '@nestjs/common';
import { z } from 'zod';
import { Chain, SignedTransaction } from '../../../packages/shared/src/contracts';
import { Rpc, RpcFailure } from '../../../packages/chain/src/rpc';
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
export class BroadcastRpc extends Rpc {
  async broadcast(chain: Chain, signed: SignedTransaction) {
    await this.verifyNetwork(chain);
    const hash =
      chain === 'ethereum'
        ? await this.call(chain, 'eth_sendRawTransaction', [signed.raw])
        : chain === 'bitcoin'
          ? await this.call(chain, 'sendrawtransaction', [signed.raw])
          : await this.call(chain, 'sendTransaction', [
              signed.raw,
              { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized' },
            ]);
    if (hash !== signed.txHash)
      throw new BadGatewayException('RPC returned an unexpected transaction hash');
  }
  async status(
    chain: Chain,
    hash: string,
  ): Promise<'submitted' | 'confirmed' | 'failed' | 'unknown'> {
    await this.verifyNetwork(chain);
    if (chain === 'ethereum') {
      const raw = await this.call(chain, 'eth_getTransactionReceipt', [hash]);
      if (raw === null)
        return (await this.call(chain, 'eth_getTransactionByHash', [hash])) === null
          ? 'unknown'
          : 'submitted';
      const receipt = z.object({ blockNumber: hex, status: z.enum(['0x0', '0x1']) }).parse(raw);
      const head = hex.parse(await this.call(chain, 'eth_blockNumber', []));
      if (BigInt(head) - BigInt(receipt.blockNumber) + 1n < 12n) return 'submitted';
      return receipt.status === '0x1' ? 'confirmed' : 'failed';
    }
    if (chain === 'bitcoin') {
      try {
        const tx = z
          .object({ confirmations: z.number().int().optional() })
          .parse(await this.call(chain, 'getrawtransaction', [hash, true]));
        return (tx.confirmations ?? 0) >= 6 ? 'confirmed' : 'submitted';
      } catch (error) {
        if (error instanceof RpcFailure && error.rpcCode === -5) return 'unknown';
        throw error;
      }
    }
    const result = z
      .object({
        value: z.array(
          z.object({ err: z.unknown(), confirmationStatus: z.string().nullable() }).nullable(),
        ),
      })
      .parse(
        await this.call(chain, 'getSignatureStatuses', [
          [hash],
          { searchTransactionHistory: true },
        ]),
      );
    const status = result.value[0];
    if (!status) return 'unknown';
    if (status.confirmationStatus !== 'finalized') return 'submitted';
    return status.err ? 'failed' : 'confirmed';
  }
}
