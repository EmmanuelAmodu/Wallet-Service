import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { keccak256 } from 'ethers';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { TokenPlanner } from '../packages/chain/src/token-planner.js';
import { SweepDeferral } from '../packages/chain/src/native-sweep-planner.js';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../apps/signer/src/signing/signing.service.js';
import { CustodySigningPolicy } from '../apps/signer/src/signing/custody-signing.policy.js';
import { MessageAuth, messageSchema } from '../packages/queue/src/messages.js';
import { verifySignerAttestation } from '../packages/shared/src/execution-authorization.js';
import { TokenSigningPolicy } from '../apps/signer/src/signing/token-signing.policy.js';
import { TokenPreparation } from '../packages/chain/src/token-planner.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import {
  TokenExecutionClaims,
  signTokenExecutionAuthorization,
} from '../packages/shared/src/token-authorization.js';
import { getWalletCore } from '../packages/chain/src/coin-metadata.js';
import {
  associatedTokenAddress,
  verifySignedSplTransfer,
  verifySignedErc20Transfer,
} from '../packages/chain/src/token-encoding.js';
import { Chain } from '../packages/shared/src/contracts.js';
import {
  TokenCertificate,
  TokenSignRequest,
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_DEVNET,
  SOLANA_SYSTEM_PROGRAM,
} from '../packages/shared/src/token-contracts.js';

let signer: SigningCore;
const authority = generateKeyPairSync('ed25519');
before(async () => {
  signer = await SigningCore.create(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    'tokens',
    '11155111',
    undefined,
    {
      domainId: 'exchange',
      chainNetworks: {
        ethereum: { network: '11155111', chainId: '11155111' },
        solana: { network: SOLANA_DEVNET, genesisHash: SOLANA_DEVNET },
      },
    },
  );
});
after(() => signer.close());

function wallet(chain: 'ethereum' | 'solana', account: number): TokenSignRequest['wallet'] {
  const { path: _path, ...wallet } = signer.derive({ chain, account, seedId: 'tokens' });
  return { ...wallet, network: chain === 'ethereum' ? '11155111' : SOLANA_DEVNET };
}

class FakeRpc extends ChainRpcService {
  constructor(readonly handler: (method: string, params: unknown[]) => unknown | Promise<unknown>) {
    super({ ethereumChainId: '11155111', solanaGenesisHash: SOLANA_DEVNET });
  }

  override async call(_chain: Chain, method: string, params: unknown[]) {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'getGenesisHash') return SOLANA_DEVNET;
    return this.handler(method, params);
  }
}
const code = '0x600160005260206000f3';
const ethCertificate: Extract<TokenCertificate, { standard: 'erc20' }> = {
  standard: 'erc20',
  chain: 'ethereum',
  network: '11155111',
  contract: '0x' + '12'.repeat(20),
  decimals: 6,
  certificateId: 'fixture-standard-transfer',
  semantics: 'exact-transfer',
  runtimeCodeHash: keccak256(code),
  upgradePolicy: 'immutable',
};
const uint = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

function ethRpc(
  options: {
    native?: bigint;
    tokens?: bigint;
    code?: string;
    decimals?: number;
    pendingNonce?: string;
    simulation?: bigint;
    gas?: string;
    recipientCode?: string;
  } = {},
) {
  return new FakeRpc((method, params) => {
    switch (method) {
      case 'eth_getCode':
        return params[0] === ethCertificate.contract
          ? (options.code ?? code)
          : String(params[0]).toLowerCase() === wallet('ethereum', 0).address.toLowerCase()
            ? (options.recipientCode ?? '0x')
            : '0x';
      case 'eth_call': {
        const data = (params[0] as { data: string }).data;
        if (data === '0x313ce567') return uint(BigInt(options.decimals ?? 6));
        if (data.startsWith('0x70a08231')) return uint(options.tokens ?? 9007199254740993n);
        if (data.startsWith('0xa9059cbb')) {
          assert.equal((params[0] as { gasPrice: string }).gasPrice, '0x0');
          assert.equal((params[0] as { gas: string }).gas, '0x30d40');
          return uint(options.simulation ?? 1n);
        }
        throw new Error('Unexpected token call');
      }
      case 'eth_getBalance':
        return '0x' + (options.native ?? 10n ** 18n).toString(16);
      case 'eth_getTransactionCount':
        return params[1] === 'pending' ? (options.pendingNonce ?? '0x7') : '0x7';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_estimateGas':
        return options.gas ?? '0xc350';
      default:
        throw new Error('Unexpected RPC ' + method);
    }
  });
}

const deferral = (code: string) => (error: unknown) =>
  error instanceof SweepDeferral && error.code === code;

test('ERC-20 canonical preparation signs exact units, identifies token/nonce resources and revalidates fee liquidity', async () => {
  const planner = new TokenPlanner(ethRpc());
  const plan = await planner.plan({
    certificate: ethCertificate,
    wallet: wallet('ethereum', 10),
    recipientOwner: wallet('ethereum', 0).address,
  });
  assert.equal(plan.request.transaction.amount, '9007199254740993');
  assert.equal(plan.maxFeeUnits, '180000000000000');
  assert.equal(plan.fundingShortfallUnits, '0');
  assert.equal(plan.resourceKeys.length, 2);
  await planner.revalidate(plan);
  verifySignedErc20Transfer(plan.request, await signer.signToken(plan.request));
  await assert.rejects(
    new TokenPlanner(ethRpc({ native: 0n })).revalidate(plan),
    deferral('waiting_funds'),
  );
  await assert.rejects(
    new TokenPlanner(ethRpc({ pendingNonce: '0x8' })).revalidate(plan),
    deferral('waiting_resources'),
  );
  plan.request.transaction.amount = '1';
  await assert.rejects(planner.revalidate(plan), deferral('attention'));
});

test('unfunded ERC-20 source receives bounded gas quote and cannot be signed through planning revalidation', async () => {
  const planner = new TokenPlanner(ethRpc({ native: 0n }));
  const plan = await planner.plan({
    certificate: ethCertificate,
    wallet: wallet('ethereum', 10),
    recipientOwner: wallet('ethereum', 0).address,
  });
  assert.equal(plan.fundingShortfallUnits, '600000000000000');
  await assert.rejects(planner.revalidate(plan), deferral('waiting_funds'));
});

test('ERC-20 changed code, precision, false transfer, insufficient tokens and excessive gas remain exceptions', async () => {
  const input = {
    certificate: ethCertificate,
    wallet: wallet('ethereum', 0),
    recipientOwner: wallet('ethereum', 11).address,
    amount: '100',
  };
  for (const options of [
    { code: '0x6000' },
    { decimals: 8 },
    { simulation: 0n },
    { gas: '0x40000' },
  ])
    await assert.rejects(new TokenPlanner(ethRpc(options)).plan(input), deferral('attention'));
  await assert.rejects(
    new TokenPlanner(ethRpc({ tokens: 99n })).plan(input),
    deferral('waiting_funds'),
  );
});

async function splFixture(
  options: {
    existing?: boolean;
    frozen?: boolean;
    delegated?: boolean;
    program?: string;
    decimals?: number;
    payerBalance?: number;
    stale?: boolean;
    expired?: boolean;
    recipientProgram?: string;
    payerMissing?: boolean;
  } = {},
) {
  const core = await getWalletCore(),
    source = wallet('solana', 10),
    hot = wallet('solana', 0),
    payer = wallet('solana', 1);
  const mint = wallet('solana', 8).address;
  const sourceAccount = await associatedTokenAddress(source.address, mint),
    hotAccount = await associatedTokenAddress(hot.address, mint);
  const certificate: Extract<TokenCertificate, { standard: 'spl' }> = {
    standard: 'spl',
    chain: 'solana',
    network: SOLANA_DEVNET,
    mint,
    programId: CLASSIC_TOKEN_PROGRAM,
    decimals: 6,
    certificateId: 'fixture-classic-mint',
    semantics: 'exact-transfer',
    accountClosure: 'retain',
  };
  const account = (owner: string, bytes: Buffer, lamports = 2039280) => ({
    owner,
    lamports,
    executable: false,
    data: [bytes.toString('base64'), 'base64'],
  });
  const mintData = Buffer.alloc(82);
  mintData[44] = options.decimals ?? 6;
  mintData[45] = 1;
  const token = (owner: string, amount: bigint) => {
    const bytes = Buffer.alloc(165);
    Buffer.from(core.Base58.decodeNoCheck(mint)).copy(bytes);
    Buffer.from(core.Base58.decodeNoCheck(owner)).copy(bytes, 32);
    bytes.writeBigUInt64LE(amount, 64);
    bytes[108] = options.frozen ? 2 : 1;
    if (options.delegated) bytes.writeUInt32LE(1, 72);
    return account(options.program ?? CLASSIC_TOKEN_PROGRAM, bytes);
  };
  const rpc = new FakeRpc((method, params) => {
    const slot = options.stale ? 1 : 100;
    switch (method) {
      case 'getAccountInfo':
        return {
          context: { slot: 100 },
          value:
            params[0] === mint
              ? account(CLASSIC_TOKEN_PROGRAM, mintData)
              : params[0] === payer.address
                ? options.payerMissing
                  ? null
                  : account(
                      SOLANA_SYSTEM_PROGRAM,
                      Buffer.alloc(0),
                      options.payerBalance ?? 100000000,
                    )
                : params[0] === hot.address && options.recipientProgram
                  ? account(options.recipientProgram, Buffer.alloc(0))
                  : params[0] === hotAccount && options.existing
                    ? token(hot.address, 0n)
                    : null,
        };
      case 'getTokenAccountsByOwner':
        return {
          context: { slot },
          value: [{ pubkey: sourceAccount, account: token(source.address, 9007199254740993n) }],
        };
      case 'getLatestBlockhash':
        return {
          context: { slot: 100 },
          value: { blockhash: wallet('solana', 9).address, lastValidBlockHeight: 1000 },
        };
      case 'getMinimumBalanceForRentExemption':
        return params[0] === 165 ? 2039280 : 890880;
      case 'getFeeForMessage':
        return { context: { slot: 100 }, value: 10000 };
      case 'getBlockHeight':
        return options.expired ? 1001 : 900;
      case 'isBlockhashValid':
        return { context: { slot: 100 }, value: !options.expired };
      default:
        throw new Error('Unexpected SPL RPC ' + method);
    }
  });
  return {
    planner: new TokenPlanner(rpc),
    input: {
      certificate,
      wallet: source,
      recipientOwner: hot.address,
      feePayer: { ...payer, chain: 'solana' as const, account: 1 as const },
    },
    sourceAccount,
  };
}

test('SPL discovery and preparation verify binary owner/mint/precision, rent and management1 sponsorship', async () => {
  const { planner, input, sourceAccount } = await splFixture();
  const accounts = await planner.discoverOwnedAccounts(input.certificate, input.wallet.address);
  assert.equal(accounts[0].address, sourceAccount);
  assert.equal(accounts[0].state, 'spendable');
  const plan = await planner.plan(input);
  assert.equal(plan.rentUnits, '2039280');
  assert.equal(plan.maxFeeUnits, '10000');
  assert.equal(plan.fundingShortfallUnits, '0');
  await planner.revalidate(plan);
  const signed = await signer.signToken(plan.request);
  assert.equal((await verifySignedSplTransfer(plan.request, signed)).requiredSignatures, 2);
});

function claims(plan: TokenPreparation): TokenExecutionClaims {
  const source = signer.derive({
    chain: plan.certificate.chain,
    account: plan.request.wallet.account,
    seedId: signer.seedId,
  });
  const target = signer.derive({
    chain: plan.certificate.chain,
    account: 0,
    seedId: signer.seedId,
  });
  const tx = plan.request.transaction;
  return {
    version: 1,
    purpose: 'token_sweep',
    domainId: 'exchange',
    resetEpoch: 'tokens',
    seedId: signer.seedId,
    customerId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    preparationDigest: plan.preparedDigest,
    requestHash: executionDigest(plan.request),
    certificate: plan.certificate,
    policyVersion: 'exchange-token-v1',
    recipientPolicy: 'external-wallet-v1',
    expiresAt: plan.expiresAt,
    source: {
      walletId: randomUUID(),
      role: 'customer_deposit',
      account: source.account,
      path: source.path,
      address: source.address,
      registryRevision: 1,
    },
    target: {
      walletId: randomUUID(),
      role: 'hot',
      account: 0,
      path: target.path,
      address: target.address,
      registryRevision: 1,
      domainId: 'exchange',
      seedId: signer.seedId,
    },
    ...(tx.kind === 'spl'
      ? {
          sponsor: {
            walletId: randomUUID(),
            role: 'management',
            account: 1,
            path: signer.derive({ chain: 'solana', account: 1, seedId: signer.seedId }).path,
            address: tx.feePayer.address,
            registryRevision: 1,
          },
        }
      : {}),
  };
}

test('independent token authority binds source/hot derivations, certificates and management sponsor', async () => {
  const eth = await new TokenPlanner(ethRpc()).plan({
    certificate: ethCertificate,
    wallet: wallet('ethereum', 10),
    recipientOwner: wallet('ethereum', 0).address,
  });
  const sol = await splFixture(),
    spl = await sol.planner.plan(sol.input);
  const policy = new TokenSigningPolicy(
    {
      enabled: true,
      domainId: 'exchange',
      resetEpoch: 'tokens',
      authorityPublicKey: authority.publicKey,
    },
    signer,
  );
  for (const plan of [eth, spl]) {
    const c = claims(plan),
      auth = signTokenExecutionAuthorization(c, authority.privateKey);
    assert.ok((await policy.sign(plan, auth)).raw);
    assert.throws(
      () => policy.authorize(plan, { ...auth, signature: 'A'.repeat(86) }),
      /authorization/,
    );
    const rebound = { ...c, resetEpoch: 'stale' };
    assert.throws(
      () => policy.authorize(plan, signTokenExecutionAuthorization(rebound, authority.privateKey)),
      /identity/,
    );
    const wrongSource = structuredClone(c);
    wrongSource.source.path = signer.derive({
      chain: plan.certificate.chain,
      account: 11,
      seedId: signer.seedId,
    }).path;
    assert.throws(
      () =>
        policy.authorize(plan, signTokenExecutionAuthorization(wrongSource, authority.privateKey)),
      /path/,
    );
    assert.throws(
      () =>
        new TokenSigningPolicy(
          { enabled: false, domainId: 'exchange', resetEpoch: 'tokens' },
          signer,
        ).authorize(plan, auth),
      /disabled/,
    );
  }
  const wrongSponsor = claims(spl);
  delete wrongSponsor.sponsor;
  assert.throws(
    () =>
      policy.authorize(spl, signTokenExecutionAuthorization(wrongSponsor, authority.privateKey)),
    /sponsor/,
  );
});

test('EOA-only token recipients reject deployed/delegated Ethereum code and Solana programs/PDAs', async () => {
  const input = {
    certificate: ethCertificate,
    wallet: wallet('ethereum', 10),
    recipientOwner: wallet('ethereum', 0).address,
  };
  const original = await new TokenPlanner(ethRpc()).plan(input);
  for (const recipientCode of ['0x6000', '0xef0100' + '12'.repeat(20)]) {
    const planner = new TokenPlanner(ethRpc({ recipientCode }));
    await assert.rejects(planner.plan(input), /recipient/);
    await assert.rejects(planner.revalidate(original), /recipient/);
  }
  const program = await splFixture({ recipientProgram: CLASSIC_TOKEN_PROGRAM });
  await assert.rejects(program.planner.plan(program.input), /System account/);
  const sol = await splFixture();
  await assert.rejects(
    sol.planner.plan({ ...sol.input, recipientOwner: sol.sourceAccount }),
    /on-curve/,
  );
});

test('SPL rejects frozen/delegated accounts, Token-2022, incorrect precision and stale discovery', async () => {
  for (const options of [
    { frozen: true },
    { delegated: true },
    { program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
    { decimals: 8 },
    { stale: true },
  ]) {
    const { planner, input } = await splFixture(options);
    await assert.rejects(planner.plan(input), deferral('attention'));
  }
});

test('SPL expired blockhash and depleted native fee/rent remain unsigned with exact token principal retained', async () => {
  const original = await splFixture(),
    plan = await original.planner.plan(original.input);
  const depleted = await splFixture({ payerBalance: 890880 });
  const quote = await depleted.planner.plan(depleted.input);
  assert.equal(quote.fundingShortfallUnits, '2049280');
  const missing = await splFixture({ payerMissing: true });
  assert.equal((await missing.planner.plan(missing.input)).fundingShortfallUnits, '2940160');
  await assert.rejects(depleted.planner.revalidate(plan), deferral('waiting_funds'));
  const expired = await splFixture({ expired: true });
  await assert.rejects(expired.planner.revalidate(plan), deferral('preparation_expired'));
});

test('private token queue signs only an independently authorized preparation and attests bound results', async () => {
  const plan = await new TokenPlanner(ethRpc()).plan({
    certificate: ethCertificate,
    wallet: wallet('ethereum', 10),
    recipientOwner: wallet('ethereum', 0).address,
  });
  const c = claims(plan),
    attestor = generateKeyPairSync('ed25519');
  const service = new SigningService(
    signer,
    new CustodySigningPolicy(
      {
        enabled: true,
        sweepsEnabled: false,
        withdrawalsEnabled: false,
        domainId: 'exchange',
        resetEpoch: 'tokens',
        authorityPublicKey: authority.publicKey,
        attestationPrivateKey: attestor.privateKey,
      },
      signer,
    ),
    new TokenSigningPolicy(
      {
        enabled: true,
        domainId: 'exchange',
        resetEpoch: 'tokens',
        authorityPublicKey: authority.publicKey,
      },
      signer,
    ),
  );
  const command = messageSchema.parse({
    type: 'transaction.token.sign',
    transactionId: randomUUID(),
    operationId: c.operationId,
    attemptId: c.attemptId,
    requestDigest: c.requestDigest,
    preparationDigest: plan.preparedDigest,
    prepared: plan,
    authorization: signTokenExecutionAuthorization(c, authority.privateKey),
  });
  assert.equal(command.type, 'transaction.token.sign');
  if (command.type !== 'transaction.token.sign') return;
  const auth = new MessageAuth('q'.repeat(64), 'tokens'),
    id = 'token-command-fixture';
  const parsed = auth.open(auth.seal(command, id), id, command.type);
  assert.equal(parsed.type, 'transaction.token.sign');
  const result = await service.executeToken(command);
  assert.equal(result.type, 'transaction.custody.signed');
  if (result.type !== 'transaction.custody.signed') return;
  const { signerAttestation, ...unsigned } = result;
  assert.equal(
    verifySignerAttestation(signerAttestation, unsigned, attestor.publicKey).status,
    'signed',
  );
  verifySignedErc20Transfer(plan.request, result.signed);
  assert.throws(() => messageSchema.parse({ ...command, attemptId: randomUUID() }), /binding/);
  const unauthorized = {
    ...command,
    authorization: { ...command.authorization, signature: 'a'.repeat(86) },
  };
  const rejected = await service.executeToken(unauthorized);
  assert.equal(rejected.type, 'transaction.custody.rejected');
  assert.throws(() => service.execute(command), /Unsupported signer/);
});
