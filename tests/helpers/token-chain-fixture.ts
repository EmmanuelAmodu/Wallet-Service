import { Transaction, keccak256 } from 'ethers';
import { createHash } from 'node:crypto';
import { BroadcastRpcService } from '../../apps/broadcast/src/broadcast/broadcast-rpc.service.js';
import { Chain, SignedTransaction, SignRequest } from '../../packages/shared/src/contracts.js';
import { TokenPreparation } from '../../packages/chain/src/token-planner.js';
import {
  TokenSignRequest,
  TokenCertificate,
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_DEVNET,
  SOLANA_SYSTEM_PROGRAM,
} from '../../packages/shared/src/token-contracts.js';
import {
  associatedTokenAddress,
  decodeLegacySolanaTransaction,
} from '../../packages/chain/src/token-encoding.js';
import { getWalletCore } from '../../packages/chain/src/coin-metadata.js';
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const topic = (address: string) => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const fixtureTokenCode = '0x600160005260206000f3';
export const ercCertificate: TokenCertificate = {
  standard: 'erc20',
  chain: 'ethereum',
  network: '11155111',
  contract: '0x' + 'ab'.repeat(20),
  decimals: 6,
  certificateId: 'end-to-end-exact-transfer',
  semantics: 'exact-transfer',
  runtimeCodeHash: keccak256(fixtureTokenCode),
  upgradePolicy: 'immutable',
};
interface Entry {
  request: SignRequest | TokenSignRequest;
  prepared?: TokenPreparation;
  signed: SignedTransaction;
  submitted: boolean;
  included: boolean;
  block: number;
  receipt?: unknown;
  failed?: boolean;
}
interface Account {
  owner: string;
  mint: string;
  amount: bigint;
  lamports: number;
}
/** Deterministic canonical provider/RPC fixture; all signing and saga/database code is real. */
export class TokenChainFixture extends BroadcastRpcService {
  readonly entries = new Map<string, Entry>();
  readonly native = new Map<string, bigint>();
  readonly tokens = new Map<string, bigint>();
  readonly nonces = new Map<string, number>();
  readonly accounts = new Map<string, Account>();
  solCertificate?: Extract<TokenCertificate, { standard: 'spl' }>;
  head = 100;
  orphaned = new Set<number>();
  outage = false;
  recipientCode = '0x';
  constructor() {
    super({
      ethereumChainId: '11155111',
      solanaGenesisHash: SOLANA_DEVNET,
      chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
    });
  }

  balance(address: string) {
    return this.native.get(address.toLowerCase()) ?? this.native.get(address) ?? 0n;
  }

  setBalance(address: string, n: bigint) {
    this.native.set(address.startsWith('0x') ? address.toLowerCase() : address, n);
  }

  setTokens(address: string, n: bigint) {
    this.tokens.set(address.toLowerCase(), n);
  }

  blockHash(block: number) {
    return (
      '0x' +
      createHash('sha256')
        .update(`fixture:${block}:${this.orphaned.has(block) ? 'orphan' : 'canonical'}`)
        .digest('hex')
    );
  }

  register(snapshot: {
    signed: SignedTransaction;
    execution?: { preparedRequest: SignRequest | TokenSignRequest; tokenPreparation?: unknown };
  }) {
    const e = snapshot.execution!;
    if (!this.entries.has(snapshot.signed.txHash))
      this.entries.set(snapshot.signed.txHash, {
        request: e.preparedRequest,
        prepared: e.tokenPreparation as TokenPreparation | undefined,
        signed: snapshot.signed,
        included: false,
        submitted: false,
        block: ++this.head,
      });
  }

  override async broadcast(_chain: Chain, signed: SignedTransaction) {
    const e = this.entries.get(signed.txHash);
    if (!e) throw new Error('Unsigned/unknown broadcast');
    e.submitted = true;
  }

  override async preflight() {
    /* Native signature and output checking occurs in the real planner/Signer. */
  }

  async include(hash: string, failed = false) {
    const e = this.entries.get(hash)!;
    if (e.included) return;
    e.failed = failed;
    if (e.request.transaction.chain === 'ethereum') {
      const tx = Transaction.from(e.signed.raw),
        fee = (tx.data === '0x' ? 21000n : 50000n) * 2_000_000_000n;
      this.setBalance(tx.from!, this.balance(tx.from!) - fee - (failed ? 0n : tx.value));
      if (!failed && tx.value > 0n) this.setBalance(tx.to!, this.balance(tx.to!) + tx.value);
      if (!failed && 'kind' in e.request.transaction) {
        const t = e.request.transaction;
        if (t.kind !== 'erc20') throw new Error('adapter');
        this.setTokens(
          tx.from!,
          (this.tokens.get(tx.from!.toLowerCase()) ?? 0n) - BigInt(t.amount),
        );
        this.setTokens(
          t.recipient,
          (this.tokens.get(t.recipient.toLowerCase()) ?? 0n) + BigInt(t.amount),
        );
      }
      this.nonces.set(tx.from!.toLowerCase(), tx.nonce + 1);
    } else if (
      e.prepared &&
      e.request.transaction.chain === 'solana' &&
      'kind' in e.request.transaction
    ) {
      const t = e.request.transaction;
      if (t.kind !== 'spl') throw new Error('adapter');
      const decoded = decodeLegacySolanaTransaction(e.signed.raw),
        core = await getWalletCore(),
        keys = decoded.keys.map((k) => core.Base58.encodeNoCheck(k));
      const pre = keys.map((k) => Number(this.balance(k)) || this.accounts.get(k)?.lamports || 0),
        source = this.accounts.get(t.sourceTokenAccount)!,
        target = this.accounts.get(t.recipientTokenAccount);
      const balances = (accountIndex: number, owner: string, amount: bigint) => ({
        accountIndex,
        mint: t.mint,
        owner,
        programId: CLASSIC_TOKEN_PROGRAM,
        uiTokenAmount: { amount: amount.toString(), decimals: t.decimals },
      });
      const preToken = [
        balances(keys.indexOf(t.sourceTokenAccount), source.owner, source.amount),
        ...(target
          ? [balances(keys.indexOf(t.recipientTokenAccount), target.owner, target.amount)]
          : []),
      ];
      const fee = keys[0] === e.request.wallet.address ? 5000 : 10000,
        rent = !failed && t.createRecipientAccount ? 2039280 : 0;
      this.setBalance(keys[0], this.balance(keys[0]) - BigInt(fee + rent));
      if (!failed) {
        source.amount -= BigInt(t.amount);
        this.accounts.set(t.recipientTokenAccount, {
          owner: t.recipientOwner,
          mint: t.mint,
          amount: (target?.amount ?? 0n) + BigInt(t.amount),
          lamports: target?.lamports ?? rent,
        });
      }
      const post = pre.map((v, i) =>
        i === 0 ? v - fee - rent : i === keys.indexOf(t.recipientTokenAccount) && rent ? rent : v,
      );
      const postToken = [
        balances(keys.indexOf(t.sourceTokenAccount), source.owner, source.amount),
        ...(!failed
          ? [
              balances(
                keys.indexOf(t.recipientTokenAccount),
                t.recipientOwner,
                this.accounts.get(t.recipientTokenAccount)!.amount,
              ),
            ]
          : target
            ? [balances(keys.indexOf(t.recipientTokenAccount), target.owner, target.amount)]
            : []),
      ];
      e.receipt = {
        slot: e.block,
        transaction: [e.signed.raw, 'base64'],
        meta: {
          err: failed ? { InstructionError: [0, 'Custom'] } : null,
          fee,
          preBalances: pre,
          postBalances: post,
          preTokenBalances: preToken,
          postTokenBalances: postToken,
        },
      };
    } else throw new Error('Unsupported fixture transfer');
    e.included = true;
  }

  private async solAccount(address: string) {
    const core = await getWalletCore();
    if (this.solCertificate && address === this.solCertificate.mint) {
      const raw = Buffer.alloc(82);
      raw.writeUInt32LE(1, 0);
      raw.writeBigUInt64LE(1_000_000n, 36);
      raw[44] = this.solCertificate.decimals;
      raw[45] = 1;
      return {
        owner: CLASSIC_TOKEN_PROGRAM,
        executable: false,
        lamports: 1461600,
        data: [raw.toString('base64'), 'base64'],
      };
    }
    const account = this.accounts.get(address);
    if (account) {
      const raw = Buffer.alloc(165);
      Buffer.from(core.Base58.decodeNoCheck(account.mint)).copy(raw, 0);
      Buffer.from(core.Base58.decodeNoCheck(account.owner)).copy(raw, 32);
      raw.writeBigUInt64LE(account.amount, 64);
      raw[108] = 1;
      return {
        owner: CLASSIC_TOKEN_PROGRAM,
        executable: false,
        lamports: account.lamports,
        data: [raw.toString('base64'), 'base64'],
      };
    }
    if (this.native.has(address))
      return {
        owner: SOLANA_SYSTEM_PROGRAM,
        executable: false,
        lamports: Number(this.balance(address)),
        data: ['', 'base64'],
      };
    return null;
  }

  override async call(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
    if (this.outage) throw new Error('Fixture RPC outage');
    const hash = String(params[0]),
      e = this.entries.get(hash);
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7';
      case 'getGenesisHash':
        return SOLANA_DEVNET;
      case 'eth_getBalance':
        return hex(this.balance(hash));
      case 'eth_getCode':
        return ercCertificate.standard === 'erc20' && hash.toLowerCase() === ercCertificate.contract
          ? fixtureTokenCode
          : this.recipientCode;
      case 'eth_getTransactionCount':
        return hex(
          (this.nonces.get(hash.toLowerCase()) ?? 0) +
            (params[1] === 'pending' &&
            [...this.entries.values()].some(
              (e) =>
                e.submitted &&
                !e.included &&
                e.request.wallet.address.toLowerCase() === hash.toLowerCase(),
            )
              ? 1
              : 0),
        );
      case 'eth_maxPriorityFeePerGas':
        return hex(1_000_000_000n);
      case 'eth_estimateGas':
        return hex(
          String((params[0] as { data?: string }).data ?? '0x').startsWith('0xa9059cbb')
            ? 50000
            : 21000,
        );
      case 'eth_call': {
        const d = (params[0] as { data: string }).data;
        if (d === '0x313ce567') return word(6n);
        if (d.startsWith('0x70a08231'))
          return word(this.tokens.get('0x' + d.slice(-40).toLowerCase()) ?? 0n);
        if (d.startsWith('0xa9059cbb')) return word(1n);
        throw new Error('Unexpected readonly token call');
      }
      case 'eth_getBlockByNumber': {
        const block = hash === 'latest' || hash === 'finalized' ? this.head : Number(BigInt(hash));
        return {
          number: hex(block),
          hash: this.blockHash(block),
          baseFeePerGas: hex(1_000_000_000n),
          transactions: [...this.entries.values()]
            .filter((e) => e.included && e.block === block && !this.orphaned.has(block))
            .map((e) => e.signed.txHash),
        };
      }
      case 'eth_getTransactionReceipt':
        if (!e?.included) return null;
        {
          const tx = Transaction.from(e.signed.raw),
            isToken = 'kind' in e.request.transaction && e.request.transaction.kind === 'erc20';
          const logs =
            isToken && !e.failed
              ? [
                  {
                    address: tx.to,
                    topics: [
                      transferTopic,
                      topic(tx.from!),
                      topic(
                        (
                          e.request.transaction as Extract<
                            TokenSignRequest['transaction'],
                            { kind: 'erc20' }
                          >
                        ).recipient,
                      ),
                    ],
                    data: word(
                      BigInt(
                        (
                          e.request.transaction as Extract<
                            TokenSignRequest['transaction'],
                            { kind: 'erc20' }
                          >
                        ).amount,
                      ),
                    ),
                    transactionHash: hash,
                    blockHash: this.blockHash(e.block),
                    blockNumber: hex(e.block),
                    logIndex: '0x0',
                    removed: false,
                  },
                ]
              : [];
          return {
            transactionHash: hash,
            blockHash: this.blockHash(e.block),
            blockNumber: hex(e.block),
            status: e.failed ? '0x0' : '0x1',
            gasUsed: hex(isToken ? 50000 : 21000),
            effectiveGasPrice: hex(2_000_000_000n),
            logs,
          };
        }
      case 'eth_getTransactionByHash':
        if (!e) return null;
        {
          const tx = Transaction.from(e.signed.raw);
          return {
            hash,
            from: tx.from,
            to: tx.to,
            value: hex(tx.value),
            nonce: hex(tx.nonce),
            input: tx.data,
            blockHash: e.included ? this.blockHash(e.block) : null,
            blockNumber: e.included ? hex(e.block) : null,
          };
        }
      case 'getBalance':
        return { context: { slot: this.head }, value: Number(this.balance(hash)) };
      case 'getAccountInfo':
        return { context: { slot: this.head }, value: await this.solAccount(hash) };
      case 'getTokenAccountsByOwner':
        return {
          context: { slot: this.head },
          value: await Promise.all(
            [...this.accounts]
              .filter(
                ([, a]) =>
                  a.owner === hash &&
                  (!(params[1] as { mint?: string }).mint ||
                    a.mint === (params[1] as { mint: string }).mint),
              )
              .map(async ([pubkey]) => ({ pubkey, account: await this.solAccount(pubkey) })),
          ),
        };
      case 'getMinimumBalanceForRentExemption':
        return Number(params[0]) === 0 ? 890880 : 2039280;
      case 'getLatestBlockhash':
        return {
          context: { slot: this.head },
          value: {
            blockhash: (await getWalletCore()).Base58.encodeNoCheck(Buffer.alloc(32, 3)),
            lastValidBlockHeight: 1000,
          },
        };
      case 'getFeeForMessage': {
        const raw = Buffer.from(hash, 'base64');
        return { context: { slot: this.head }, value: raw[0] * 5000 };
      }
      case 'getSignaturesForAddress':
        return [...this.entries.values()]
          .filter(
            (e) =>
              e.included &&
              e.request.wallet.chain === 'solana' &&
              (e.request.wallet.address === hash ||
                ('feePayer' in e.request.transaction &&
                  e.request.transaction.feePayer.address === hash)),
          )
          .map((e) => ({ signature: e.signed.txHash, slot: e.block }));
      case 'getSlot':
        return this.head;
      case 'getblockchaininfo':
        return { chain: 'regtest' };
      case 'scantxoutset':
        return { success: true, height: this.head, bestblock: 'ab'.repeat(32), unspents: [] };
      case 'getblockhash':
        return 'ab'.repeat(32);
      case 'getBlockHeight':
        return this.head;
      case 'isBlockhashValid':
        return { context: { slot: this.head }, value: this.head <= 1000 };
      case 'simulateTransaction':
        return { value: { err: null } };
      case 'getTransaction':
        return e?.included ? e.receipt : null;
      case 'getBlock': {
        const block = Number(params[0]);
        return {
          blockhash: this.orphaned.has(block) ? '5'.repeat(32) : '4'.repeat(32),
          signatures: [...this.entries.values()]
            .filter((e) => e.included && e.block === block && !this.orphaned.has(block))
            .map((e) => e.signed.txHash),
        };
      }
      default:
        throw new Error(`Unsupported fixture RPC ${chain}:${method}`);
    }
  }

  async receiveSpl(owner: string, amount: bigint, mint: string) {
    const address = await associatedTokenAddress(owner, mint);
    this.accounts.set(address, { owner, mint, amount, lamports: 2039280 });
    return address;
  }
}
