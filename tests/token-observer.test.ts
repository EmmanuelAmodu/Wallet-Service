import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { keccak256 } from 'ethers';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import { TokenObserver } from '../packages/chain/src/token-observer.js';
import { TokenPreparation } from '../packages/chain/src/token-planner.js';
import {
  associatedTokenAddress,
  verifySignedSplTransfer,
} from '../packages/chain/src/token-encoding.js';
import { getWalletCore } from '../packages/chain/src/coin-metadata.js';
import { executionDigest } from '../packages/shared/src/execution-authorization.js';
import { Chain } from '../packages/shared/src/contracts.js';
import {
  TokenCertificate,
  TokenSignRequest,
  tokenSignRequestSchema,
  tokenAsset,
  SOLANA_DEVNET,
  CLASSIC_TOKEN_PROGRAM,
} from '../packages/shared/src/token-contracts.js';
let core: SigningCore;
before(async () => {
  core = await SigningCore.create(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    'observer',
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
after(() => core.close());

function wallet(chain: 'ethereum' | 'solana', account: number): TokenSignRequest['wallet'] {
  const { path: _path, ...w } = core.derive({ chain, account, seedId: 'observer' });
  return { ...w, network: chain === 'ethereum' ? '11155111' : SOLANA_DEVNET };
}

function prepare(
  certificate: TokenCertificate,
  request: TokenSignRequest,
  resources: string[],
  fee: string,
  rent = '0',
): TokenPreparation {
  const value = {
    certificate,
    certificateDigest: executionDigest(certificate),
    request,
    principalAsset: tokenAsset(certificate),
    feeAsset: {
      chain: certificate.chain,
      network: certificate.network,
      assetId: `token:${certificate.chain}:native`,
    },
    maxFeeUnits: fee,
    rentUnits: rent,
    fundingShortfallUnits: '0',
    resourceKeys: resources,
    // Confirming an already signed transaction must work after its preparation expired.
    expiresAt: new Date(Date.now() - 60000).toISOString(),
  };
  return { ...value, preparedDigest: executionDigest(value) };
}

class Rpc extends ChainRpcService {
  constructor(readonly handler: (method: string, params: unknown[]) => unknown | Promise<unknown>) {
    super({ ethereumChainId: '11155111', solanaGenesisHash: SOLANA_DEVNET });
  }

  override async call(_chain: Chain, method: string, params: unknown[]) {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'getGenesisHash') return SOLANA_DEVNET;
    return this.handler(method, params);
  }
}

async function ethFixture() {
  const code = '0x600160005260206000f3',
    source = wallet('ethereum', 10),
    recipient = wallet('ethereum', 0);
  const certificate: TokenCertificate = {
    standard: 'erc20',
    chain: 'ethereum',
    network: '11155111',
    contract: '0x' + '12'.repeat(20),
    decimals: 6,
    certificateId: 'fixture',
    semantics: 'exact-transfer',
    runtimeCodeHash: keccak256(code),
    upgradePolicy: 'immutable',
  };
  const request = tokenSignRequestSchema.parse({
    wallet: source,
    transaction: {
      kind: 'erc20',
      chain: 'ethereum',
      chainId: '11155111',
      contract: certificate.contract,
      recipient: recipient.address,
      amount: '100',
      nonce: '7',
      gasLimit: '60000',
      maxFeePerGas: '3000000000',
      maxPriorityFeePerGas: '1000000000',
    },
  });
  const prepared = prepare(
    certificate,
    request,
    [
      `nonce:${source.address.toLowerCase()}:7`,
      `token:${certificate.contract}:${source.address.toLowerCase()}`,
    ],
    '180000000000000',
  );
  const signed = await core.signToken(request),
    blockHash = '0x' + '44'.repeat(32);
  const receipt = {
    transactionHash: signed.txHash,
    blockHash,
    blockNumber: '0x10',
    status: '0x1',
    gasUsed: '0xc350',
    effectiveGasPrice: '0x77359400',
    logs: [
      {
        address: certificate.contract,
        transactionHash: signed.txHash,
        blockHash,
        logIndex: '0x0',
        removed: false,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x' + source.address.slice(2).toLowerCase().padStart(64, '0'),
          '0x' + recipient.address.slice(2).toLowerCase().padStart(64, '0'),
        ],
        data: '0x' + 100n.toString(16).padStart(64, '0'),
      },
    ],
  };
  const observer = (overrides: Record<string, unknown> = {}) =>
    new TokenObserver(
      new Rpc((method, params) => {
        if (method in overrides) return overrides[method];
        switch (method) {
          case 'eth_getTransactionReceipt':
            return receipt;
          case 'eth_getTransactionByHash':
            return {
              hash: signed.txHash,
              from: source.address,
              to: certificate.contract,
              value: '0x0',
              nonce: '0x7',
              input:
                '0xa9059cbb' +
                recipient.address.slice(2).toLowerCase().padStart(64, '0') +
                100n.toString(16).padStart(64, '0'),
              blockHash,
              blockNumber: '0x10',
            };
          case 'eth_getCode':
            return code;
          case 'eth_getBlockByNumber':
            return {
              hash: blockHash,
              number: params[0] === 'finalized' ? '0x20' : '0x10',
              transactions: [signed.txHash],
            };
          default:
            throw new Error(method);
        }
      }),
    );
  return { prepared, signed, receipt, observer, blockHash };
}

test('canonical ERC-20 success proves recipient, exact principal and native fees after preparation expiry', async () => {
  const f = await ethFixture(),
    result = await f.observer().observe(f.prepared, f.signed);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.actualFeeUnits, '100000000000000');
  assert.equal(result.feePayerAddress, f.prepared.request.wallet.address);
  assert.equal(
    (await f.observer({ eth_getTransactionReceipt: null }).observe(f.prepared, f.signed)).state,
    'pending',
  );
});

test('canonical ERC-20 false token semantics, fee-on-transfer logs and changed code cannot settle', async () => {
  const f = await ethFixture();
  const wrong = structuredClone(f.receipt);
  wrong.logs[0].data = '0x' + 99n.toString(16).padStart(64, '0');
  await assert.rejects(
    f.observer({ eth_getTransactionReceipt: wrong }).observe(f.prepared, f.signed),
    /principal/,
  );
  const feeOnTransfer = structuredClone(f.receipt);
  feeOnTransfer.logs.push(feeOnTransfer.logs[0]);
  await assert.rejects(
    f.observer({ eth_getTransactionReceipt: feeOnTransfer }).observe(f.prepared, f.signed),
    /semantics/,
  );
  await assert.rejects(
    f.observer({ eth_getCode: '0x6000' }).observe(f.prepared, f.signed),
    /certification/,
  );
});

test('canonical failed ERC-20 pays only native fees; proven orphaning differs from RPC outage', async () => {
  const f = await ethFixture(),
    failed = { ...f.receipt, status: '0x0', logs: [] };
  assert.equal(
    (await f.observer({ eth_getTransactionReceipt: failed }).observe(f.prepared, f.signed)).state,
    'failed',
  );
  const prior = { blockHash: '0x' + '55'.repeat(32), blockHeight: '16' };
  assert.equal((await f.observer().observe(f.prepared, f.signed, prior)).state, 'reverted');
  const unavailable = new TokenObserver(
    new Rpc(() => {
      throw new RpcFailure();
    }),
  );
  await assert.rejects(unavailable.observe(f.prepared, f.signed, prior), RpcFailure);
});

async function splFixture(create = true, failed = false) {
  const source = wallet('solana', 10),
    recipient = wallet('solana', 0),
    payer = wallet('solana', 1),
    mint = wallet('solana', 8).address;
  const sourceToken = await associatedTokenAddress(source.address, mint),
    targetToken = await associatedTokenAddress(recipient.address, mint);
  const certificate: TokenCertificate = {
    standard: 'spl',
    chain: 'solana',
    network: SOLANA_DEVNET,
    mint,
    programId: CLASSIC_TOKEN_PROGRAM,
    decimals: 6,
    certificateId: 'fixture',
    semantics: 'exact-transfer',
    accountClosure: 'retain',
  };
  const request = tokenSignRequestSchema.parse({
    wallet: source,
    transaction: {
      kind: 'spl',
      chain: 'solana',
      mint,
      programId: CLASSIC_TOKEN_PROGRAM,
      sourceTokenAccount: sourceToken,
      recipientOwner: recipient.address,
      recipientTokenAccount: targetToken,
      amount: '100',
      decimals: 6,
      createRecipientAccount: create,
      recentBlockhash: wallet('solana', 9).address,
      lastValidBlockHeight: 1000,
      feePayer: { ...payer, chain: 'solana', account: 1 },
      accountClosure: 'retain',
    },
  });
  const prepared = prepare(
    certificate,
    request,
    [
      `solana:${payer.address}`,
      `solana:${source.address}`,
      `token:${mint}:${sourceToken}`,
      `token:${mint}:${targetToken}`,
    ],
    '10000',
    create ? '2039280' : '0',
  );
  const signed = await core.signToken(request),
    decoded = await verifySignedSplTransfer(request, signed),
    wc = await getWalletCore();
  const keys = decoded.keys.map((key) => wc.Base58.encodeNoCheck(key)),
    sourceIndex = keys.indexOf(sourceToken),
    targetIndex = keys.indexOf(targetToken);
  const preBalances = keys.map(() => 100000000),
    postBalances = [...preBalances];
  if (create) preBalances[targetIndex] = postBalances[targetIndex] = 0;
  postBalances[0] -= 10000;
  if (create && !failed) {
    postBalances[0] -= 2039280;
    postBalances[targetIndex] = 2039280;
  }
  const balance = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex,
    owner,
    mint,
    programId: CLASSIC_TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6 },
  });
  const transaction = {
    slot: 100,
    transaction: [signed.raw, 'base64'],
    meta: {
      err: failed ? { InstructionError: [0, 'Custom'] } : null,
      fee: 10000,
      preBalances,
      postBalances,
      preTokenBalances: [
        balance(sourceIndex, source.address, '200'),
        ...(!create ? [balance(targetIndex, recipient.address, '50')] : []),
      ],
      postTokenBalances: failed
        ? [
            balance(sourceIndex, source.address, '200'),
            ...(!create ? [balance(targetIndex, recipient.address, '50')] : []),
          ]
        : [
            balance(sourceIndex, source.address, '100'),
            balance(targetIndex, recipient.address, create ? '100' : '150'),
          ],
    },
  };
  const observer = (overrides: Record<string, unknown> = {}) =>
    new TokenObserver(
      new Rpc((method) => {
        if (method in overrides) return overrides[method];
        if (method === 'getTransaction') return transaction;
        if (method === 'getBlock')
          return { blockhash: wallet('solana', 9).address, signatures: [signed.txHash] };
        throw new Error(method);
      }),
    );
  return { prepared, signed, transaction, observer };
}

test('canonical sponsored SPL verifies exact token deltas and allocates fees/rent to management1', async () => {
  for (const create of [false, true]) {
    const f = await splFixture(create),
      result = await f.observer().observe(f.prepared, f.signed);
    assert.equal(result.state, 'confirmed');
    assert.equal(result.actualFeeUnits, '10000');
    assert.equal(result.actualRentUnits, create ? '2039280' : '0');
    if (f.prepared.request.transaction.kind === 'spl')
      assert.equal(result.feePayerAddress, f.prepared.request.transaction.feePayer.address);
  }
});

test('canonical SPL mismatched amount, owner, mint and native payer cannot settle', async () => {
  const f = await splFixture();
  for (const field of ['amount', 'owner', 'mint', 'payer']) {
    const bad = structuredClone(f.transaction);
    if (field === 'amount') bad.meta.postTokenBalances[0].uiTokenAmount.amount = '101';
    if (field === 'owner') bad.meta.postTokenBalances[0].owner = wallet('solana', 11).address;
    if (field === 'mint') bad.meta.postTokenBalances[0].mint = wallet('solana', 7).address;
    if (field === 'payer') bad.meta.postBalances[0]++;
    await assert.rejects(
      f.observer({ getTransaction: bad }).observe(f.prepared, f.signed),
      /evidence mismatch/,
    );
  }
});

test('canonical SPL failure proves fee-only movement and unavailable/history gaps remain pending', async () => {
  const f = await splFixture(true, true),
    result = await f.observer().observe(f.prepared, f.signed);
  assert.equal(result.state, 'failed');
  assert.equal(result.actualRentUnits, '0');
  assert.equal(
    (await f.observer({ getTransaction: null }).observe(f.prepared, f.signed)).state,
    'pending',
  );
  assert.equal(
    (
      await f
        .observer({ getBlock: { blockhash: wallet('solana', 9).address, signatures: [] } })
        .observe(f.prepared, f.signed)
    ).state,
    'reverted',
  );
});
