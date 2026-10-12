import { Injectable } from '@nestjs/common';
import { keccak256 } from 'ethers';
import { z } from 'zod';
import { ChainRpcService } from './chain-rpc.service.js';
import { getWalletCore } from './coin-metadata.js';
import { associatedTokenAddress, erc20TransferData, splTransferMessage } from './token-encoding.js';
import {
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  TokenCertificate,
  TokenSignRequest,
  tokenAsset,
  tokenCertificateSchema,
  tokenSignRequestSchema,
} from '../../shared/src/token-contracts.js';
import { executionDigest } from '../../shared/src/execution-authorization.js';
import { SweepDeferral } from './native-sweep-planner.js';
import { assertEvmExternalAddress, assertSolanaExternalAddress } from './recipient-policy.js';

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const context = z.object({ slot: safe });
const rpcAccount = z.object({
  owner: z.string(),
  executable: z.boolean(),
  lamports: safe,
  data: z.tuple([z.string(), z.literal('base64')]),
});
type RpcAccount = z.infer<typeof rpcAccount>;
type Wallet = TokenSignRequest['wallet'];
export interface OwnedTokenAccount {
  address: string;
  owner: string;
  mint: string;
  amount: string;
  state: 'spendable' | 'unsupported';
  reason?: string;
}
export interface TokenPreparation {
  certificate: TokenCertificate;
  certificateDigest: string;
  request: TokenSignRequest;
  principalAsset: ReturnType<typeof tokenAsset>;
  feeAsset: { chain: 'ethereum' | 'solana'; network: string; assetId: string };
  maxFeeUnits: string;
  rentUnits: string;
  fundingShortfallUnits: string;
  resourceKeys: string[];
  expiresAt: string;
  preparedDigest: string;
}
export interface TokenPlanInput {
  certificate: TokenCertificate;
  wallet: Wallet;
  recipientOwner: string;
  amount?: string;
  sourceTokenAccount?: string;
  feePayer?: Extract<TokenSignRequest['transaction'], { kind: 'spl' }>['feePayer'];
}

function reject(reason: string): never {
  throw new SweepDeferral('attention', reason);
}

function data(account: RpcAccount, length: number): Buffer {
  const raw = Buffer.from(account.data[0], 'base64');
  if (raw.length !== length || raw.toString('base64') !== account.data[0] || account.executable)
    reject('Unsupported or malformed classic token account layout');
  return raw;
}

function positiveUnits(amount: string, maximum = (1n << 256n) - 1n): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(amount) || BigInt(amount) > maximum)
    reject('Invalid exact token units');
  return BigInt(amount);
}

export function validateTokenPreparation(prepared: TokenPreparation): void {
  const { preparedDigest, ...binding } = prepared;
  if (
    executionDigest(binding) !== preparedDigest ||
    prepared.certificateDigest !== executionDigest(prepared.certificate)
  )
    reject('Token preparation digest mismatch');
  const c = tokenCertificateSchema.parse(prepared.certificate);
  const request = tokenSignRequestSchema.parse(prepared.request),
    tx = request.transaction;
  if (
    c.chain !== request.wallet.chain ||
    c.network !== request.wallet.network ||
    executionDigest(tokenAsset(c)) !== executionDigest(prepared.principalAsset) ||
    prepared.feeAsset.chain !== c.chain ||
    prepared.feeAsset.network !== c.network ||
    prepared.feeAsset.assetId !== `token:${c.chain}:native` ||
    !Number.isFinite(Date.parse(prepared.expiresAt))
  )
    reject('Token preparation asset binding mismatch');
  for (const units of [prepared.maxFeeUnits, prepared.rentUnits, prepared.fundingShortfallUnits])
    if (!/^(0|[1-9][0-9]{0,77})$/.test(units) || BigInt(units) >= 1n << 256n)
      reject('Invalid token preparation budget');
  let resources: string[];
  if (c.standard === 'erc20' && tx.kind === 'erc20') {
    if (
      tx.contract !== c.contract ||
      prepared.rentUnits !== '0' ||
      BigInt(prepared.maxFeeUnits) !== BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) ||
      BigInt(prepared.maxFeeUnits) > 5_000_000_000_000_000n
    )
      reject('ERC-20 preparation certificate or fee mismatch');
    resources = [
      `nonce:${request.wallet.address.toLowerCase()}:${tx.nonce}`,
      `token:${c.contract}:${request.wallet.address.toLowerCase()}`,
    ];
  } else if (c.standard === 'spl' && tx.kind === 'spl') {
    if (
      tx.mint !== c.mint ||
      tx.programId !== c.programId ||
      tx.decimals !== c.decimals ||
      BigInt(prepared.maxFeeUnits) <
        (request.wallet.address === tx.feePayer.address ? 5000n : 10000n) ||
      BigInt(prepared.maxFeeUnits) > 100000n ||
      BigInt(prepared.rentUnits) > 10_000_000n ||
      (tx.createRecipientAccount ? BigInt(prepared.rentUnits) <= 0n : prepared.rentUnits !== '0')
    )
      reject('SPL preparation certificate, precision or native budget mismatch');
    resources = [
      `solana:${tx.feePayer.address}`,
      `solana:${request.wallet.address}`,
      `token:${c.mint}:${tx.sourceTokenAccount}`,
      `token:${c.mint}:${tx.recipientTokenAccount}`,
    ].filter((key, index, list) => list.indexOf(key) === index);
  } else reject('Token preparation adapter mismatch');
  if (executionDigest(resources) !== executionDigest(prepared.resourceKeys))
    reject('Token preparation resource identity mismatch');
}

/** Canonical read-only token preparation. Its resources and funding quote must be durably held before dispatch. */
@Injectable()
export class TokenPlanner {
  constructor(private readonly rpc: ChainRpcService) {}

  private async verify(certificate: TokenCertificate) {
    if (this.rpc.networkIdentity(certificate.chain) !== certificate.network)
      reject('Token network does not match pinned canonical RPC');
    await this.rpc.verifyNetwork(certificate.chain);
  }

  private async account(address: string, minContextSlot?: number) {
    const response = z.object({ context, value: rpcAccount.nullable() }).parse(
      await this.rpc.call('solana', 'getAccountInfo', [
        address,
        {
          encoding: 'base64',
          commitment: 'finalized',
          ...(minContextSlot === undefined ? {} : { minContextSlot }),
        },
      ]),
    );
    if (minContextSlot !== undefined && response.context.slot < minContextSlot)
      reject('Token account evidence predates the required slot');
    return response;
  }

  async validateCertificate(certificate: TokenCertificate) {
    const c=tokenCertificateSchema.parse(certificate);
    if(c.standard==='spl') return this.validateMint(c);
    await this.verify(c);
    for(const tag of ['finalized','pending']) {
      const code=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/).parse(await this.rpc.call('ethereum','eth_getCode',[c.contract,tag]));
      if(keccak256(code)!==c.runtimeCodeHash) reject('Certified token code changed');
      if(code.toLowerCase().startsWith('0xef0100')) reject('Delegated token code is unsupported');
      const raw=Buffer.from(code.slice(2),'hex');
      for(let i=0;i<raw.length;i++) {const op=raw[i];if([0xf2,0xf4,0xff].includes(op)) reject('Proxy/delegation/destruction token code is unsupported');if(op>=0x60&&op<=0x7f)i+=op-0x5f;}
      const precision=word.parse(await this.rpc.call('ethereum','eth_call',[{to:c.contract,data:'0x313ce567'},tag]));
      if(BigInt(precision)!==BigInt(c.decimals)) reject('Certified token precision changed');
    }
  }

  async validateMint(certificate: Extract<TokenCertificate, { standard: 'spl' }>) {
    const c = tokenCertificateSchema.parse(certificate);
    if (c.standard !== 'spl') reject('Expected SPL certificate');
    await this.verify(c);
    const result = await this.account(c.mint);
    if (!result.value || result.value.owner !== CLASSIC_TOKEN_PROGRAM)
      reject('Mint is missing or owned by an unsupported token program');
    const mint = data(result.value, 82);
    if (
      ![0, 1].includes(mint.readUInt32LE(0)) ||
      mint[45] !== 1 || (mint[44]===0 && mint.readBigUInt64LE(36)===1n) ||
      mint[44] !== c.decimals ||
      mint.readUInt32LE(46) !== 0
    )
      reject('Mint precision, initialization or freeze authority is not certified');
    return result.context.slot;
  }

  private async ownedAccount(
    address: string,
    account: RpcAccount,
    owner: string,
    mint: string,
  ): Promise<OwnedTokenAccount> {
    const core = await getWalletCore();
    const raw = data(account, 165);
    const actualMint = core.Base58.encodeNoCheck(raw.subarray(0, 32));
    const actualOwner = core.Base58.encodeNoCheck(raw.subarray(32, 64));
    if (account.owner !== CLASSIC_TOKEN_PROGRAM || actualMint !== mint || actualOwner !== owner)
      reject('Token account owner, program or mint identity mismatch');
    const unsupported =
      raw[108] !== 1 ||
      raw.readUInt32LE(72) !== 0 ||
      raw.readUInt32LE(109) !== 0 ||
      raw.readBigUInt64LE(121) !== 0n ||
      raw.readUInt32LE(129) !== 0;
    return {
      address,
      mint,
      owner,
      amount: raw.readBigUInt64LE(64).toString(),
      state: unsupported ? 'unsupported' : 'spendable',
      ...(unsupported
        ? { reason: 'Frozen, uninitialized, delegated, wrapped-native or closable account' }
        : {}),
    };
  }

  async discoverOwnedAccounts(
    certificate: Extract<TokenCertificate, { standard: 'spl' }>,
    owner: string,
  ) {
    const floor = await this.validateMint(certificate);
    const response = z
      .object({
        context,
        value: z.array(z.object({ pubkey: z.string(), account: rpcAccount })).max(1000),
      })
      .parse(
        await this.rpc.call('solana', 'getTokenAccountsByOwner', [
          owner,
          { mint: certificate.mint },
          { encoding: 'base64', commitment: 'finalized', minContextSlot: floor },
        ]),
      );
    if (response.context.slot < floor) reject('Token discovery evidence predates mint validation');
    if (new Set(response.value.map((entry) => entry.pubkey)).size !== response.value.length)
      reject('Duplicate owned token account evidence');
    return Promise.all(
      response.value.map((entry) =>
        this.ownedAccount(entry.pubkey, entry.account, owner, certificate.mint),
      ),
    );
  }

  async plan(input: TokenPlanInput): Promise<TokenPreparation> {
    const certificate = tokenCertificateSchema.parse(input.certificate);
    if (
      input.wallet.chain !== certificate.chain ||
      input.wallet.network !== certificate.network ||
      (input.wallet.account !== 0 && input.wallet.account < 10)
    )
      reject('Token source must be hot0 or a customer deposit derivation on the certified network');
    await this.verify(certificate);
    if (certificate.standard === 'erc20') {
      assertEvmExternalAddress(input.recipientOwner);
      const codes = await Promise.all(
        ['finalized', 'pending'].map((tag) =>
          this.rpc.call('ethereum', 'eth_getCode', [input.recipientOwner, tag]),
        ),
      );
      if (codes.some((code) => code !== '0x'))
        reject('ERC-20 recipient must have no contract or delegated code');
    } else {
      await assertSolanaExternalAddress(input.recipientOwner);
      const owner = await this.account(input.recipientOwner);
      if (
        owner.value &&
        (owner.value.owner !== SOLANA_SYSTEM_PROGRAM ||
          owner.value.executable ||
          data(owner.value, 0).length !== 0)
      )
        reject('SPL recipient owner must be an ordinary System account');
    }
    const result =
      certificate.standard === 'erc20'
        ? await this.erc20(input, certificate)
        : await this.spl(input, certificate);
    const prepared = {
      ...result,
      certificate,
      certificateDigest: executionDigest(certificate),
      principalAsset: tokenAsset(certificate),
      feeAsset: {
        chain: certificate.chain,
        network: certificate.network,
        assetId: `token:${certificate.chain}:native`,
      },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    return { ...prepared, preparedDigest: executionDigest(prepared) };
  }

  private async erc20(input: TokenPlanInput, c: Extract<TokenCertificate, { standard: 'erc20' }>) {
    const source = input.wallet.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(source)) reject('Invalid Ethereum source');
    const call = (data: string, tag = 'finalized') =>
      this.rpc.call('ethereum', 'eth_call', [{ to: c.contract, data }, tag]);
    const balanceData = '0x70a08231' + source.slice(2).padStart(64, '0');
    const [
      codeFinal,
      codePending,
      precision,
      tokensFinal,
      tokensPending,
      nativeFinal,
      nativePending,
      nonceLatest,
      noncePending,
      block,
      priorityRaw,
      sourceCode,
    ] = await Promise.all([
      this.rpc.call('ethereum', 'eth_getCode', [c.contract, 'finalized']),
      this.rpc.call('ethereum', 'eth_getCode', [c.contract, 'pending']),
      call('0x313ce567'),
      call(balanceData),
      call(balanceData, 'pending'),
      this.rpc.call('ethereum', 'eth_getBalance', [source, 'finalized']),
      this.rpc.call('ethereum', 'eth_getBalance', [source, 'pending']),
      this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'latest']),
      this.rpc.call('ethereum', 'eth_getTransactionCount', [source, 'pending']),
      this.rpc.call('ethereum', 'eth_getBlockByNumber', ['latest', false]),
      this.rpc.call('ethereum', 'eth_maxPriorityFeePerGas', []),
      this.rpc.call('ethereum', 'eth_getCode', [source, 'pending']),
    ]);
    for (const code of [codeFinal, codePending])
      if (
        typeof code !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
        keccak256(code) !== c.runtimeCodeHash
      )
        reject('Token runtime code no longer matches certification');
    if (sourceCode !== '0x') reject('Token authority must be an externally owned account');
    if (BigInt(word.parse(precision)) !== BigInt(c.decimals)) reject('Token precision changed');
    const finalized = BigInt(word.parse(tokensFinal)),
      pending = BigInt(word.parse(tokensPending));
    const available = finalized < pending ? finalized : pending;
    const amount = input.amount === undefined ? available : positiveUnits(input.amount);
    if (amount <= 0n || amount > available)
      throw new SweepDeferral('waiting_funds', 'Insufficient finalized and pending token balance');
    const latest = BigInt(quantity.parse(nonceLatest)),
      nonce = BigInt(quantity.parse(noncePending));
    if (latest !== nonce)
      throw new SweepDeferral('waiting_resources', 'Untracked pending Ethereum nonce');
    const base = BigInt(z.object({ baseFeePerGas: quantity }).parse(block).baseFeePerGas);
    const priority = BigInt(quantity.parse(priorityRaw)) || 1n,
      maxFee = base * 2n + priority;
    if (priority > 2_000_000_000n || maxFee > 100_000_000_000n)
      throw new SweepDeferral('fee_budget', 'Token gas price exceeds policy');
    const calldata = erc20TransferData(input.recipientOwner, amount.toString());
    const transfer = {
      from: source,
      to: c.contract,
      value: '0x0',
      data: calldata,
      maxFeePerGas: '0x' + maxFee.toString(16),
      maxPriorityFeePerGas: '0x' + priority.toString(16),
    };
    // eth_call must simulate semantics even before management gas funding.
    // Zero simulation gas price avoids requiring native gas balance just to quote a top-up.
    const simulation = word.parse(
      await this.rpc.call('ethereum', 'eth_call', [
        {
          from: source,
          to: c.contract,
          value: '0x0',
          data: calldata,
          gas: '0x30d40',
          gasPrice: '0x0',
        },
        'pending',
      ]),
    );
    if (BigInt(simulation) !== 1n)
      reject('Certified token transfer simulation did not return true');
    const nativeA = BigInt(quantity.parse(nativeFinal)),
      nativeB = BigInt(quantity.parse(nativePending));
    const nativeBalance = nativeA < nativeB ? nativeA : nativeB;
    // Without fee liquidity, do not rely on estimateGas accepting an unfunded sender.
    // Return a bounded conservative quote; re-plan after canonical funding confirmation.
    let gas = 200000n;
    if (nativeBalance >= gas * maxFee) {
      const estimate = BigInt(
        quantity.parse(await this.rpc.call('ethereum', 'eth_estimateGas', [transfer, 'pending'])),
      );
      gas = (estimate * 120n + 99n) / 100n;
      if (gas < 21000n || gas > 200000n) reject('Token gas estimate exceeds certified bounds');
    }
    const fee = gas * maxFee;
    if (fee > 5_000_000_000_000_000n)
      throw new SweepDeferral('fee_budget', 'Token gas reserve exceeds fixed cap');
    const request = tokenSignRequestSchema.parse({
      wallet: input.wallet,
      transaction: {
        kind: 'erc20',
        chain: 'ethereum',
        chainId: '11155111',
        contract: c.contract,
        recipient: input.recipientOwner,
        amount: amount.toString(),
        nonce: nonce.toString(),
        gasLimit: gas.toString(),
        maxFeePerGas: maxFee.toString(),
        maxPriorityFeePerGas: priority.toString(),
      },
    });
    return {
      request,
      maxFeeUnits: fee.toString(),
      rentUnits: '0',
      fundingShortfallUnits: (fee > nativeBalance ? fee - nativeBalance : 0n).toString(),
      resourceKeys: [`nonce:${source}:${nonce}`, `token:${c.contract}:${source}`],
    };
  }

  private async spl(input: TokenPlanInput, c: Extract<TokenCertificate, { standard: 'spl' }>) {
    const floor = await this.validateMint(c);
    const accounts = await this.discoverOwnedAccounts(c, input.wallet.address);
    const preferred = await associatedTokenAddress(input.wallet.address, c.mint);
    const candidate = accounts.filter(a=>a.state==='spendable' && BigInt(a.amount)>0n).sort((a,b)=>a.address===preferred?-1:b.address===preferred?1:a.address.localeCompare(b.address))[0];
    const sourceAddress = input.sourceTokenAccount ?? candidate?.address ?? preferred;
    const source = accounts.find((account) => account.address === sourceAddress);
    if (!source || source.state !== 'spendable')
      reject('Selected owned token account is not spendable');
    const amount =
      input.amount === undefined
        ? BigInt(source.amount)
        : positiveUnits(input.amount, (1n << 64n) - 1n);
    if (amount <= 0n || amount > BigInt(source.amount))
      throw new SweepDeferral('waiting_funds', 'Insufficient SPL token account balance');
    if (!input.feePayer) reject('SPL fee payer must be independently bound to custody');
    await assertSolanaExternalAddress(input.feePayer.address);
    const recipient = await associatedTokenAddress(input.recipientOwner, c.mint);
    const [destination, payer, blockRaw, tokenRentRaw, payerRentRaw] = await Promise.all([
      this.account(recipient, floor),
      this.account(input.feePayer.address, floor),
      this.rpc.call('solana', 'getLatestBlockhash', [
        { commitment: 'finalized', minContextSlot: floor },
      ]),
      this.rpc.call('solana', 'getMinimumBalanceForRentExemption', [
        165,
        { commitment: 'finalized' },
      ]),
      this.rpc.call('solana', 'getMinimumBalanceForRentExemption', [
        0,
        { commitment: 'finalized' },
      ]),
    ]);
    if (destination.value) {
      const account = await this.ownedAccount(
        recipient,
        destination.value,
        input.recipientOwner,
        c.mint,
      );
      if (account.state !== 'spendable') reject('Recipient token account is unsupported');
    }
    if (
      payer.value &&
      (payer.value.owner !== SOLANA_SYSTEM_PROGRAM ||
        payer.value.executable ||
        data(payer.value, 0).length !== 0)
    )
      reject('SPL fee payer must be an ordinary custody System account');
    const block = z
      .object({ context, value: z.object({ blockhash: z.string(), lastValidBlockHeight: safe }) })
      .parse(blockRaw);
    if (block.context.slot < floor) reject('Blockhash evidence predates token validation');
    const request = tokenSignRequestSchema.parse({
      wallet: input.wallet,
      transaction: {
        kind: 'spl',
        chain: 'solana',
        mint: c.mint,
        programId: c.programId,
        sourceTokenAccount: source.address,
        recipientOwner: input.recipientOwner,
        recipientTokenAccount: recipient,
        amount: amount.toString(),
        decimals: c.decimals,
        createRecipientAccount: destination.value === null,
        recentBlockhash: block.value.blockhash,
        lastValidBlockHeight: block.value.lastValidBlockHeight,
        feePayer: input.feePayer,
        accountClosure: 'retain',
      },
    });
    const message = await splTransferMessage(request);
    const feeResult = z
      .object({ context, value: safe.nullable() })
      .parse(
        await this.rpc.call('solana', 'getFeeForMessage', [
          message.toString('base64'),
          { commitment: 'finalized', minContextSlot: floor },
        ]),
      );
    if (feeResult.context.slot < floor || feeResult.value === null)
      throw new SweepDeferral('unavailable', 'SPL fee evidence is stale or blockhash expired');
    const fee = BigInt(feeResult.value),
      rent = destination.value ? 0n : BigInt(safe.parse(tokenRentRaw));
    if (
      fee < (request.wallet.address === input.feePayer.address ? 5000n : 10000n) ||
      fee > 100000n ||
      rent > 10_000_000n
    )
      throw new SweepDeferral('fee_budget', 'SPL fee/rent exceeds policy');
    const available = BigInt(payer.value?.lamports ?? 0) - BigInt(safe.parse(payerRentRaw));
    return {
      request,
      maxFeeUnits: fee.toString(),
      rentUnits: rent.toString(),
      fundingShortfallUnits: (fee + rent > available ? fee + rent - available : 0n).toString(),
      resourceKeys: [
        `solana:${input.feePayer.address}`,
        `solana:${input.wallet.address}`,
        `token:${c.mint}:${source.address}`,
        `token:${c.mint}:${recipient}`,
      ].filter((key, index, list) => list.indexOf(key) === index),
    };
  }

  async revalidate(prepared: TokenPreparation): Promise<void> {
    validateTokenPreparation(prepared);
    if (Date.parse(prepared.expiresAt) <= Date.now())
      throw new SweepDeferral('preparation_expired', 'Token preparation expired before dispatch');
    if (prepared.fundingShortfallUnits !== '0')
      throw new SweepDeferral('waiting_funds', 'Fee funding must confirm before token signing');
    const tx = prepared.request.transaction;
    const fresh = await this.plan({
      certificate: prepared.certificate,
      wallet: prepared.request.wallet,
      recipientOwner: tx.kind === 'erc20' ? tx.recipient : tx.recipientOwner,
      amount: tx.amount,
      ...(tx.kind === 'spl'
        ? { sourceTokenAccount: tx.sourceTokenAccount, feePayer: tx.feePayer }
        : {}),
    });
    if (fresh.fundingShortfallUnits !== '0')
      throw new SweepDeferral('waiting_funds', 'Fee payer no longer covers native fee and rent');
    if (
      BigInt(fresh.maxFeeUnits) > BigInt(prepared.maxFeeUnits) ||
      BigInt(fresh.rentUnits) > BigInt(prepared.rentUnits)
    )
      throw new SweepDeferral('fee_budget', 'Fresh token costs exceed immutable preparation');
    if (tx.kind === 'erc20') {
      if (
        fresh.request.transaction.kind !== 'erc20' ||
        fresh.request.transaction.nonce !== tx.nonce ||
        BigInt(fresh.request.transaction.gasLimit) > BigInt(tx.gasLimit) ||
        BigInt(fresh.request.transaction.maxFeePerGas) > BigInt(tx.maxFeePerGas) ||
        BigInt(fresh.request.transaction.maxPriorityFeePerGas) > BigInt(tx.maxPriorityFeePerGas)
      )
        throw new SweepDeferral(
          'waiting_resources',
          'Prepared ERC-20 nonce or gas bound is no longer valid',
        );
    } else {
      if (
        fresh.request.transaction.kind !== 'spl' ||
        fresh.request.transaction.createRecipientAccount !== tx.createRecipientAccount
      )
        throw new SweepDeferral(
          'waiting_resources',
          'Recipient token-account creation state changed',
        );
      const height = safe.parse(
        await this.rpc.call('solana', 'getBlockHeight', [{ commitment: 'finalized' }]),
      );
      const valid = z
        .object({ context, value: z.boolean() })
        .parse(
          await this.rpc.call('solana', 'isBlockhashValid', [
            tx.recentBlockhash,
            { commitment: 'finalized' },
          ]),
        );
      if (!valid.value || height > tx.lastValidBlockHeight)
        throw new SweepDeferral(
          'preparation_expired',
          'SPL blockhash expired; never mutate signed bytes',
        );
    }
  }
}
