import { executionDigest } from '../../shared/src/execution-authorization.js';
import { z } from 'zod';
import { ChainRpcService } from './chain-rpc.service.js';
import { TokenPlanner } from './token-planner.js';
import {
  TokenCertificate,
  tokenAsset,
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
} from '../../shared/src/token-contracts.js';
import { CanonicalAsset, custodyObservationSchema } from '../../queue/src/exchange-contracts.js';
import { getWalletCore } from './coin-metadata.js';

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/);
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export type CustodyObservation = z.infer<typeof custodyObservationSchema>;
export class CustodySnapshotReader {
  constructor(private readonly rpc: ChainRpcService) {}
  async read(
    wallet: { chain: string; network: string; address: string },
    certificates: TokenCertificate[],
  ): Promise<CustodyObservation[]> {
    const chain = wallet.chain as 'ethereum' | 'bitcoin' | 'solana';
    const assets: CanonicalAsset[] = [
      { chain, network: wallet.network, assetId: `token:${chain}:native` },
      ...certificates.map(tokenAsset),
    ];
    try {
      if (
        !['ethereum', 'bitcoin', 'solana'].includes(chain) ||
        this.rpc.networkIdentity(chain) !== wallet.network
      )
        throw new Error('Unsupported custody network');
      await this.rpc.verifyNetwork(chain);
      if (chain === 'ethereum') return await this.ethereum(wallet.address, assets, certificates);
      if (chain === 'bitcoin') return [await this.bitcoin(wallet.address, assets[0])];
      return await this.solana(wallet.address, assets, certificates);
    } catch {
      return assets.map((asset) => ({
        asset,
        state: 'unavailable',
        reason: 'Canonical custody evidence unavailable; previous evidence is retained',
      }));
    }
  }

  private async ethereum(
    address: string,
    assets: CanonicalAsset[],
    certificates: TokenCertificate[],
  ) {
    const block = z
      .object({ hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), number: quantity })
      .parse(await this.rpc.call('ethereum', 'eth_getBlockByNumber', ['finalized', false]));
    const output: CustodyObservation[] = [];
    for (let i = 0; i < assets.length; i++) {
      try {
        let units: string, nonce: string | undefined;
        if (i === 0) {
          units = BigInt(
            quantity.parse(
              await this.rpc.call('ethereum', 'eth_getBalance', [address, block.number]),
            ),
          ).toString();
          nonce = BigInt(
            quantity.parse(
              await this.rpc.call('ethereum', 'eth_getTransactionCount', [address, block.number]),
            ),
          ).toString();
        } else {
          const certificate = certificates[i - 1];
          if (certificate.standard !== 'erc20') throw new Error('Token chain mismatch');
          await new TokenPlanner(this.rpc).validateCertificate(certificate);
          const code = await this.rpc.call('ethereum', 'eth_getCode', [
            certificate.contract,
            block.number,
          ]);
          const { keccak256 } = await import('ethers');
          if (typeof code !== 'string' || keccak256(code) !== certificate.runtimeCodeHash)
            throw new Error('Historical token code mismatch');
          units = BigInt(
            word.parse(
              await this.rpc.call('ethereum', 'eth_call', [
                {
                  to: certificate.contract,
                  data: '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0'),
                },
                block.number,
              ]),
            ),
          ).toString();
        }
        output.push(
          custodyObservationSchema.parse({
            asset: assets[i],
            state: 'observed',
            units,
            blockHash: block.hash,
            blockHeight: BigInt(block.number).toString(),
            ...(nonce ? { nonce } : {}),
          }),
        );
      } catch {
        output.push({
          asset: assets[i],
          state: 'unavailable',
          reason: 'Canonical asset balance or transfer certificate unavailable',
        });
      }
    }
    const check = z
      .object({ hash: z.string() })
      .parse(await this.rpc.call('ethereum', 'eth_getBlockByNumber', [block.number, false]));
    if (check.hash !== block.hash) throw new Error('Custody snapshot block changed');
    return output;
  }

  private async bitcoin(address: string, asset: CanonicalAsset): Promise<CustodyObservation> {
    const scan = z
      .object({
        success: z.literal(true),
        height: safe,
        bestblock: z.string().regex(/^[a-fA-F0-9]{64}$/),
        unspents: z.array(
          z.object({
            txid: z.string().regex(/^[a-fA-F0-9]{64}$/),
            vout: safe.max(4294967295),
            amount: z.union([z.string(), z.number().finite().nonnegative()]),
          }),
        ),
      })
      .parse(await this.rpc.call('bitcoin', 'scantxoutset', ['start', [`addr(${address})`]]));
    let amount = 0n;
    for (const row of scan.unspents) {
      const text = typeof row.amount === 'number' ? row.amount.toFixed(8) : row.amount;
      const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(text);
      if (!match) throw new Error('Unsafe Bitcoin units');
      amount += BigInt(match[1]) * 100000000n + BigInt((match[2] ?? '').padEnd(8, '0'));
    }
    if ((await this.rpc.call('bitcoin', 'getblockhash', [scan.height])) !== scan.bestblock)
      throw new Error('Bitcoin custody snapshot forked');
    return {
      asset,
      state: 'observed',
      units: amount.toString(),
      blockHash: scan.bestblock,
      blockHeight: String(scan.height),
      resourceDigest: executionDigest(
        scan.unspents
          .map((u) => [
            u.txid,
            u.vout,
            typeof u.amount === 'number' ? u.amount.toFixed(8) : u.amount,
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
      recentTransactions: [
        ...new Set(scan.unspents.map((u) => u.txid).filter((id): id is string => !!id)),
      ].slice(0, 100),
    };
  }

  private async solana(owner: string, assets: CanonicalAsset[], certificates: TokenCertificate[]) {
    const slot = safe.parse(
      await this.rpc.call('solana', 'getSlot', [{ commitment: 'finalized' }]),
    );
    const account = z
      .object({
        context: z.object({ slot: safe }),
        value: z
          .object({
            owner: z.string(),
            executable: z.boolean(),
            lamports: safe,
            data: z.tuple([z.string(), z.literal('base64')]),
          })
          .nullable(),
      })
      .parse(
        await this.rpc.call('solana', 'getAccountInfo', [
          owner,
          { commitment: 'finalized', encoding: 'base64', minContextSlot: slot },
        ]),
      );
    if (
      account.context.slot < slot ||
      (account.value &&
        (account.value.owner !== SOLANA_SYSTEM_PROGRAM ||
          account.value.executable ||
          account.value.data[0] !== ''))
    )
      throw new Error('Custody System account changed');
    const response = z
      .object({
        context: z.object({ slot: safe }),
        value: z
          .array(
            z.object({
              pubkey: z.string(),
              account: z.object({
                owner: z.string(),
                lamports: safe,
                data: z.tuple([z.string(), z.literal('base64')]),
              }),
            }),
          )
          .max(10000),
      })
      .parse(
        await this.rpc.call('solana', 'getTokenAccountsByOwner', [
          owner,
          { programId: CLASSIC_TOKEN_PROGRAM },
          { commitment: 'finalized', encoding: 'base64', minContextSlot: slot },
        ]),
      );
    if (
      response.context.slot < slot ||
      new Set(response.value.map((r) => r.pubkey)).size !== response.value.length
    )
      throw new Error('Stale or duplicate owned-account evidence');
    const core = await getWalletCore();
    let rent = 0n;
    const totals = new Map<string, bigint>();
    for (const row of response.value) {
      const data = Buffer.from(row.account.data[0], 'base64');
      if (
        data.length !== 165 ||
        row.account.owner !== CLASSIC_TOKEN_PROGRAM ||
        core.Base58.encodeNoCheck(data.subarray(32, 64)) !== owner
      )
        throw new Error('Owned-token-account identity mismatch');
      rent += BigInt(row.account.lamports);
      const mint = core.Base58.encodeNoCheck(data.subarray(0, 32));
      totals.set(mint, (totals.get(mint) ?? 0n) + data.readBigUInt64LE(64));
    }
    // minContextSlot is a freshness floor, not an exact historical account snapshot.
    // Refuse mixed contexts rather than claim a single-slot reconciled balance.
    if (account.context.slot !== response.context.slot)
      throw new Error('Solana account observations span different slots');
    const block = z
      .object({ blockhash: z.string() })
      .nullable()
      .parse(
        await this.rpc.call('solana', 'getBlock', [
          account.context.slot,
          { commitment: 'finalized', transactionDetails: 'none', rewards: false },
        ]),
      );
    if (!block) throw new Error('Canonical Solana block unavailable');
    const signatures = z
      .array(z.object({ signature: z.string(), slot: safe }))
      .parse(
        await this.rpc.call('solana', 'getSignaturesForAddress', [
          owner,
          { commitment: 'finalized', limit: 100 },
        ]),
      );
    const common = { blockHash: block.blockhash, blockHeight: String(account.context.slot) };
    const output: CustodyObservation[] = [
      {
        asset: assets[0],
        state: 'observed',
        units: String(account.value?.lamports ?? 0),
        rentUnits: rent.toString(),
        recentTransactions: signatures
          .filter((s) => s.slot <= account.context.slot)
          .map((s) => s.signature),
        ...common,
      },
    ];
    for (let i = 0; i < certificates.length; i++) {
      const c = certificates[i];
      try {
        if (c.standard !== 'spl') throw new Error('Token network mismatch');
        await new TokenPlanner(this.rpc).validateCertificate(c);
        output.push({
          asset: assets[i + 1],
          state: 'observed',
          units: (totals.get(c.mint) ?? 0n).toString(),
          ...common,
        });
      } catch {
        output.push({
          asset: assets[i + 1],
          state: 'unavailable',
          reason: 'Classic mint certification unavailable',
        });
      }
    }
    const check = z
      .object({ blockhash: z.string() })
      .nullable()
      .parse(
        await this.rpc.call('solana', 'getBlock', [
          account.context.slot,
          { commitment: 'finalized', transactionDetails: 'none', rewards: false },
        ]),
      );
    if (check?.blockhash !== block.blockhash) throw new Error('Solana custody snapshot forked');
    return output;
  }
}
