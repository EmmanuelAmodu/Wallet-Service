import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ChainRpcService, RpcFailure } from '../packages/chain/src/chain-rpc.service.js';
import {
  CLASSIC_SPL_TOKEN_PROGRAM,
  ExchangeVerifier,
  ExchangeVerifierOptions,
} from '../packages/chain/src/exchange-verifier.js';
import { Chain } from '../packages/shared/src/contracts.js';
import {
  ExchangeDiscoverySignal,
  exchangeDiscoverySchema,
} from '../packages/shared/src/exchange-discovery.js';

const HASH = '0x' + 'ab'.repeat(32);
const BLOCK = '0x' + 'cd'.repeat(32);
const FROM = '0x' + 'aa'.repeat(20);
const TO = '0x' + 'bb'.repeat(20);
const CONTRACT = '0x' + 'ee'.repeat(20);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SIGNATURE = '2'.repeat(88);
const SOL_FROM = '3'.repeat(44);
const SOL_TO = '4'.repeat(44);
const TOKEN_FROM = '5'.repeat(44);
const TOKEN_TO = '6'.repeat(44);
const MINT = '7'.repeat(44);
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqaWoxPkrZBG';

function signal(chain: Chain = 'ethereum', network = '11155111', transactionHash = HASH) {
  return exchangeDiscoverySchema.parse({
    schemaVersion: 1,
    resetEpoch: 'test-epoch',
    discoveryId: 'provider-1',
    chain,
    network,
    transactionHash,
    source: 'live',
  });
}

function mockRpc(
  network: string,
  respond: (method: string, params: unknown[]) => unknown,
  options: ExchangeVerifierOptions = {},
) {
  const calls: { method: string; params: unknown[] }[] = [];
  let verified = false;
  const rpc = {
    networkIdentity: () => network,
    verifyNetwork: async () => {
      verified = true;
    },
    call: async (_chain: Chain, method: string, params: unknown[]) => {
      calls.push({ method, params });
      return respond(method, params);
    },
  } as unknown as ChainRpcService;
  return { verifier: new ExchangeVerifier(rpc, options), calls, verified: () => verified };
}

function evmFixture() {
  const tx = {
    hash: HASH,
    chainId: '0xaa36a7',
    from: FROM,
    to: TO,
    value: '0x20000000000001',
    blockHash: BLOCK,
    blockNumber: '0xa',
  };
  const receipt = {
    transactionHash: HASH,
    blockHash: BLOCK,
    blockNumber: '0xa',
    from: FROM,
    to: TO,
    status: '0x1',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
    logs: [] as unknown[],
  };
  const block = { hash: BLOCK, number: '0xa' };
  let finalized: unknown = block;
  const respond = (method: string, params: unknown[]) => {
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getTransactionByHash') return tx;
    if (method === 'eth_getBlockByNumber') return params[0] === 'finalized' ? finalized : block;
    throw new Error(`Unexpected RPC: ${method}`);
  };
  return {
    tx,
    receipt,
    block,
    respond,
    finalize: (value: unknown) => {
      finalized = value;
    },
  };
}

function transferLog(index: number, amount: bigint) {
  return {
    address: CONTRACT.toUpperCase().replace('0X', '0x'),
    transactionHash: HASH,
    blockHash: BLOCK,
    blockNumber: '0xa',
    logIndex: `0x${index.toString(16)}`,
    topics: [TRANSFER, '0x' + '0'.repeat(24) + FROM.slice(2), '0x' + '0'.repeat(24) + TO.slice(2)],
    data: '0x' + amount.toString(16).padStart(64, '0'),
    removed: false,
  };
}

test('exchange discoveries are strict hints and normalize aliases without accepting money', () => {
  const input = {
    ...signal(),
    chain: 'bsc',
    transactionHash: HASH.toUpperCase().replace('0X', '0x'),
  };
  const parsed = exchangeDiscoverySchema.parse(input);
  assert.equal(parsed.chain, 'smartChain');
  assert.equal(parsed.transactionHash, HASH);
  assert.throws(() => exchangeDiscoverySchema.parse({ ...input, amount: '100' }));
  assert.throws(() => exchangeDiscoverySchema.parse({ ...input, confirmations: 900 }));
});

test('EVM canonical native amount and each ERC20 log keep exact base units and separate identities', async () => {
  const fixture = evmFixture();
  fixture.receipt.logs.push(transferLog(4, 9_007_199_254_740_999n), transferLog(7, 17n));
  const mocked = mockRpc('11155111', fixture.respond);
  const output = await mocked.verifier.verify(signal());
  assert.equal(mocked.verified(), true);
  assert.equal(output.state, 'finalized');
  assert.equal(output.transfersComplete, true);
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['9007199254740993', '9007199254740999', '17'],
  );
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.identity.id),
    [`${HASH}:native`, `${HASH}:log:4`, `${HASH}:log:7`],
  );
  assert.equal(output.transfers[1].asset.assetId, `token:ethereum:erc20:${CONTRACT}`);
  assert.equal(output.fee?.amount, '21000000000000');
  assert.ok(!mocked.calls.some((call) => call.method === 'eth_blockNumber'));
});

test('EVM unsupported or stalled finalized head remains pending with no confirmation fallback', async () => {
  const fixture = evmFixture();
  fixture.finalize({ hash: '0x' + '11'.repeat(32), number: '0x9' });
  const mocked = mockRpc('11155111', fixture.respond);
  assert.equal((await mocked.verifier.verify(signal())).state, 'pending');
  fixture.finalize(null);
  assert.equal((await mocked.verifier.verify(signal())).state, 'pending');
  const unavailable = mockRpc('11155111', (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized')
      throw new RpcFailure(-32602);
    return fixture.respond(method, params);
  });
  assert.equal((await unavailable.verifier.verify(signal())).state, 'pending');
});

test('EVM discovery network, transaction, receipt and canonical block mismatches fail closed', async () => {
  const fixture = evmFixture();
  const mocked = mockRpc('11155111', fixture.respond);
  await assert.rejects(mocked.verifier.verify(signal('ethereum', '1')), /network mismatch/);
  fixture.tx.hash = '0x' + '22'.repeat(32);
  await assert.rejects(mocked.verifier.verify(signal()), /transaction hash mismatch/);
  fixture.tx.hash = HASH;
  fixture.receipt.transactionHash = '0x' + '33'.repeat(32);
  await assert.rejects(mocked.verifier.verify(signal()), /receipt transaction mismatch/);
  fixture.receipt.transactionHash = HASH;
  fixture.block.hash = '0x' + '44'.repeat(32);
  const reverted = await mocked.verifier.verify(signal());
  assert.equal(reverted.state, 'reverted');
  assert.deepEqual(reverted.transfers, []);
});

test('EVM failed transactions emit the fee and never native or token transfers', async () => {
  const fixture = evmFixture();
  fixture.receipt.status = '0x0';
  fixture.receipt.logs.push(transferLog(0, 123n));
  const output = await mockRpc('11155111', fixture.respond).verifier.verify(signal());
  assert.equal(output.state, 'failed');
  assert.equal(output.transfersComplete, true);
  assert.deepEqual(output.transfers, []);
  assert.equal(output.fee?.payer, FROM);
});

test('callTracer binds the root and excludes reverted descendants and delegate values', async () => {
  const fixture = evmFixture();
  const trace = {
    type: 'CALL',
    from: FROM,
    to: TO,
    value: fixture.tx.value,
    calls: [
      { type: 'CALL', from: TO, to: FROM, value: '0x5' },
      {
        type: 'CALL',
        from: TO,
        to: FROM,
        value: '0x6',
        error: 'execution reverted',
        calls: [{ type: 'CALL', from: FROM, to: TO, value: '0x7' }],
      },
      { type: 'DELEGATECALL', from: TO, to: CONTRACT, value: '0xff' },
    ],
  };
  const mocked = mockRpc(
    '11155111',
    (method, params) =>
      method === 'debug_traceTransaction' ? trace : fixture.respond(method, params),
    { evmTraceMode: 'callTracer' },
  );
  const output = await mocked.verifier.verify(signal());
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['9007199254740993', '5'],
  );
  assert.equal(output.transfers[1].identity.id, `${HASH}:trace:0`);
  trace.from = CONTRACT;
  await assert.rejects(mocked.verifier.verify(signal()), /trace root source mismatch/);
});

test('canonical recheck rejects a reorg during EVM decoding', async () => {
  const fixture = evmFixture();
  let canonicalReads = 0;
  const mocked = mockRpc('11155111', (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] !== 'finalized' && ++canonicalReads === 2)
      return { hash: '0x' + 'ff'.repeat(32), number: '0xa' };
    return fixture.respond(method, params);
  });
  const output = await mocked.verifier.verify(signal());
  assert.equal(output.state, 'reverted');
  assert.deepEqual(output.transfers, []);
});

function bitcoinRaw(inputTxid: string, inputVout: number, amounts: bigint[], coinbase = false) {
  const vout = Buffer.alloc(4);
  vout.writeUInt32LE(coinbase ? 0xffffffff : inputVout);
  const input = Buffer.concat([
    Buffer.from(inputTxid, 'hex').reverse(),
    vout,
    Buffer.from('00ffffffff', 'hex'),
  ]);
  const outputs = amounts.map((amount) => {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(amount);
    return Buffer.concat([value, Buffer.from('0151', 'hex')]);
  });
  const wire = Buffer.concat([
    Buffer.from('0200000001', 'hex'),
    input,
    Buffer.from([amounts.length]),
    ...outputs,
    Buffer.alloc(4),
  ]);
  const txid = createHash('sha256')
    .update(createHash('sha256').update(wire).digest())
    .digest()
    .reverse()
    .toString('hex');
  return {
    txid,
    hex: wire.toString('hex'),
    vout: amounts.map((_amount, n) => ({
      n,
      value: 999999,
      scriptPubKey: { hex: '51', address: n === 0 ? 'bcrt1receiver' : 'bcrt1change' },
    })),
  };
}

test('Bitcoin keeps repeated receiver outputs separate and derives sats and input fees from raw bytes', async () => {
  const previous = bitcoinRaw('0'.repeat(64), 0, [900719925474099n], true);
  previous.vout[0].scriptPubKey.address = 'bcrt1source';
  const tx = {
    ...bitcoinRaw(previous.txid, 0, [900719925474000n, 1n]),
    blockhash: 'aa'.repeat(32),
  };
  tx.vout[1].scriptPubKey.address = 'bcrt1receiver';
  const header = { hash: tx.blockhash, height: 123, confirmations: 6 };
  const mocked = mockRpc('regtest', (method, params) => {
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    if (method === 'getrawtransaction') return params[0] === tx.txid ? tx : previous;
    if (method === 'getblockheader') return header;
    if (method === 'getblockhash') return tx.blockhash;
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const output = await mocked.verifier.verify(signal('bitcoin', 'regtest', tx.txid));
  assert.equal(output.state, 'finalized');
  assert.equal(output.transfersComplete, true);
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['900719925474000', '1'],
  );
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.identity.id),
    [`${tx.txid}:0`, `${tx.txid}:1`],
  );
  assert.equal(output.fee?.amount, '98');
  assert.deepEqual(output.spentInputs, [
    { address: 'bcrt1source', amount: '900719925474099', outpoint: `${previous.txid}:0` },
  ]);
  header.confirmations = 5;
  assert.equal(
    (await mocked.verifier.verify(signal('bitcoin', 'regtest', tx.txid))).state,
    'pending',
  );
  header.confirmations = -1;
  assert.equal(
    (await mocked.verifier.verify(signal('bitcoin', 'regtest', tx.txid))).state,
    'reverted',
  );
});

test('Bitcoin refuses spoofed raw tx identity or output scripts and missing prevout history', async () => {
  const previous = bitcoinRaw('0'.repeat(64), 0, [100n], true);
  const tx = bitcoinRaw(previous.txid, 0, [90n]);
  const mocked = mockRpc('mainnet', (method, params) => {
    if (method === 'getrawtransaction') return params[0] === tx.txid ? tx : previous;
    throw new Error('missing history');
  });
  tx.vout[0].scriptPubKey.hex = '52';
  await assert.rejects(
    mocked.verifier.verify(signal('bitcoin', 'mainnet', tx.txid)),
    /script mismatch/,
  );
  tx.vout[0].scriptPubKey.hex = '51';
  tx.hex = previous.hex;
  await assert.rejects(
    mocked.verifier.verify(signal('bitcoin', 'mainnet', tx.txid)),
    /raw transaction hash mismatch/,
  );
  tx.hex = bitcoinRaw(previous.txid, 0, [90n]).hex;
  previous.hex = '00';
  await assert.rejects(
    mocked.verifier.verify(signal('bitcoin', 'mainnet', tx.txid)),
    /truncated Bitcoin/,
  );
});

test('Bitcoin coinbase credit waits for maturity and configured regtest RPC must identify regtest', async () => {
  const tx = { ...bitcoinRaw('0'.repeat(64), 0, [5000000000n], true), blockhash: 'aa'.repeat(32) };
  const header = { hash: tx.blockhash, height: 1, confirmations: 99 };
  const mocked = mockRpc('regtest', (method) => {
    if (method === 'getblockchaininfo') return { chain: 'regtest' };
    if (method === 'getrawtransaction') return tx;
    if (method === 'getblockheader') return header;
    if (method === 'getblockhash') return tx.blockhash;
    throw new Error(method);
  });
  assert.equal(
    (await mocked.verifier.verify(signal('bitcoin', 'regtest', tx.txid))).state,
    'pending',
  );
  header.confirmations = 100;
  assert.equal(
    (await mocked.verifier.verify(signal('bitcoin', 'regtest', tx.txid))).state,
    'finalized',
  );
  await assert.rejects(
    mockRpc('regtest', () => ({ chain: 'main' })).verifier.verify(
      signal('bitcoin', 'regtest', tx.txid),
    ),
  );
});

test('Bitcoin SegWit txid excludes witness bytes while output sats remain exact', async () => {
  const previous = bitcoinRaw('0'.repeat(64), 0, [123456n], true);
  const tx = bitcoinRaw(previous.txid, 0, [123400n]);
  const legacy = tx.hex;
  tx.hex = `${legacy.slice(0, 8)}0001${legacy.slice(8, -8)}0101aa${legacy.slice(-8)}`;
  const mocked = mockRpc('mainnet', (_method, params) => (params[0] === tx.txid ? tx : previous));
  const output = await mocked.verifier.verify(signal('bitcoin', 'mainnet', tx.txid));
  assert.equal(output.state, 'pending');
  assert.equal(output.transfersComplete, false);
  assert.equal(output.transfers[0].amount, '123400');
  assert.equal(output.fee?.amount, '56');
});

function solFixture() {
  const tx = {
    slot: 101,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [SOL_FROM, SOL_TO, TOKEN_FROM, TOKEN_TO],
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: SOL_FROM,
                destination: SOL_TO,
                lamports: 17,
              },
            },
          },
          {
            programId: CLASSIC_SPL_TOKEN_PROGRAM,
            parsed: {
              type: 'transferChecked',
              info: {
                source: TOKEN_FROM,
                destination: TOKEN_TO,
                mint: MINT,
                tokenAmount: { amount: '9007199254740999' },
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null as unknown,
      fee: 5000,
      innerInstructions: [
        {
          index: 1,
          instructions: [
            {
              programId: '11111111111111111111111111111111',
              parsed: {
                type: 'transfer',
                info: {
                  source: SOL_FROM,
                  destination: SOL_TO,
                  lamports: 19,
                },
              },
            },
          ],
        },
      ],
      preTokenBalances: [
        { accountIndex: 2, owner: SOL_FROM, mint: MINT, programId: CLASSIC_SPL_TOKEN_PROGRAM },
        { accountIndex: 3, owner: SOL_TO, mint: MINT, programId: CLASSIC_SPL_TOKEN_PROGRAM },
      ],
      postTokenBalances: [],
      logMessages: [
        'Program 11111111111111111111111111111111 invoke [2]',
        'Program 11111111111111111111111111111111 success',
      ],
    },
  };
  const block = { blockhash: '8'.repeat(44), signatures: [SIGNATURE] };
  return {
    tx,
    block,
    respond: (method: string) => {
      if (method === 'getTransaction') return tx;
      if (method === 'getBlock') return block;
      if (method === 'getAccountInfo')
        return { context: { slot: tx.slot }, value: { owner: '11111111111111111111111111111111' } };
      throw new Error(method);
    },
  };
}

test('Solana finalized native, SPL and inner transfers retain instruction and token identities', async () => {
  const fixture = solFixture();
  const mocked = mockRpc(GENESIS, fixture.respond);
  const output = await mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(output.state, 'finalized');
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['17', '9007199254740999', '19'],
  );
  assert.match(output.transfers[1].identity.id, /instruction:1:token:solana:spl:/);
  assert.match(output.transfers[2].identity.id, /instruction:1:inner:0:native$/);
  assert.equal(output.transfers[1].to, TOKEN_TO);
  assert.deepEqual(
    output.tokenAccounts?.map((account) => account.owner),
    [SOL_FROM, SOL_TO],
  );
  assert.deepEqual(mocked.calls[0].params[1], {
    commitment: 'finalized',
    encoding: 'jsonParsed',
    maxSupportedTransactionVersion: 0,
  });
});

test('Solana incomplete metadata, unsafe numeric amounts, signature and canonical block mismatches fail closed', async () => {
  const fixture = solFixture();
  const mocked = mockRpc(GENESIS, fixture.respond);
  fixture.tx.transaction.signatures[0] = '9'.repeat(88);
  await assert.rejects(
    mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /signature mismatch/,
  );
  fixture.tx.transaction.signatures[0] = SIGNATURE;
  fixture.block.signatures = [];
  assert.equal(
    (await mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE))).state,
    'reverted',
  );
  fixture.block.signatures = [SIGNATURE];
  fixture.tx.transaction.message.instructions[0].parsed.info.lamports = 9007199254740992;
  await assert.rejects(mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE)));
  fixture.tx.transaction.message.instructions[0].parsed.info.lamports = 17;
  fixture.tx.meta.preTokenBalances.pop();
  await assert.rejects(
    mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /account metadata missing/,
  );
});

test('Solana failed finalized execution never credits parsed instruction amounts', async () => {
  const fixture = solFixture();
  fixture.tx.meta.err = { InstructionError: [1, 'InsufficientFunds'] };
  const output = await mockRpc(GENESIS, fixture.respond).verifier.verify(
    signal('solana', GENESIS, SIGNATURE),
  );
  assert.equal(output.state, 'failed');
  assert.deepEqual(output.transfers, []);
  assert.equal(output.fee?.amount, '5000');
  assert.equal(
    (await mockRpc(GENESIS, () => null).verifier.verify(signal('solana', GENESIS, SIGNATURE)))
      .state,
    'pending',
  );
});

test('EVM discovery contents never override transaction amounts, receiver or failed status', async () => {
  const fixture = evmFixture();
  const spoofed = { ...signal(), amount: '999999', to: FROM } as ExchangeDiscoverySignal;
  await assert.rejects(mockRpc('11155111', fixture.respond).verifier.verify(spoofed));
});

test('canonical history distinguishes a known orphan from missing, pruned or unavailable data', async () => {
  const known = mockRpc('11155111', () => ({ hash: BLOCK, number: '0xa' }));
  assert.equal(await known.verifier.isCanonicalBlock('ethereum', '11155111', '10', BLOCK), true);
  assert.equal(await known.verifier.isCanonicalBlock('ethereum', '11155111', '10', HASH), false);
  assert.equal(
    await mockRpc('11155111', () => null).verifier.isCanonicalBlock(
      'ethereum',
      '11155111',
      '10',
      BLOCK,
    ),
    null,
  );
  assert.equal(
    await mockRpc('11155111', () => {
      throw new RpcFailure(-32001);
    }).verifier.isCanonicalBlock('ethereum', '11155111', '10', BLOCK),
    null,
  );
  await assert.rejects(
    known.verifier.isCanonicalBlock('ethereum', '1', '10', BLOCK),
    /network mismatch/,
  );
  const btc = mockRpc('mainnet', () => 'aa'.repeat(32));
  assert.equal(
    await btc.verifier.isCanonicalBlock('bitcoin', 'mainnet', '10', 'bb'.repeat(32)),
    false,
  );
  const sol = mockRpc(GENESIS, () => ({ blockhash: SOL_FROM }));
  assert.equal(await sol.verifier.isCanonicalBlock('solana', GENESIS, '10', SOL_FROM), true);
  assert.equal(
    await mockRpc(GENESIS, () => null).verifier.isCanonicalBlock('solana', GENESIS, '10', SOL_FROM),
    null,
  );
});

test('Solana CPI transfers require execution logs and reject failed frame ambiguity', async () => {
  const fixture = solFixture();
  fixture.tx.meta.logMessages = [];
  fixture.tx.meta.logMessages.push(
    `Program ${CLASSIC_SPL_TOKEN_PROGRAM} failed: custom program error`,
  );
  await assert.rejects(
    mockRpc(GENESIS, fixture.respond).verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /failed Solana CPI/,
  );
  const withoutLogs = { ...fixture.tx, meta: { ...fixture.tx.meta, logMessages: null } };
  await assert.rejects(
    mockRpc(GENESIS, (method) =>
      method === 'getTransaction' ? withoutLogs : fixture.block,
    ).verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /execution logs missing/,
  );
});

test('missing canonical RPC history is incomplete instead of an empty proven transfer set', async () => {
  const fixture = evmFixture();
  const missingEvm = mockRpc('11155111', (method, params) => {
    if (method === 'eth_getBlockByNumber') return null;
    return fixture.respond(method, params);
  });
  const pending = await missingEvm.verifier.verify(signal());
  assert.equal(pending.state, 'pending');
  assert.equal(pending.transfersComplete, false);
  const sol = solFixture();
  const missingSol = mockRpc(GENESIS, (method) =>
    method === 'getBlock' ? null : sol.respond(method),
  );
  const solPending = await missingSol.verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(solPending.state, 'pending');
  assert.equal(solPending.transfersComplete, false);
  const unknownTransaction = mockRpc('11155111', () => null);
  assert.equal((await unknownTransaction.verifier.verify(signal())).transfersComplete, false);
  fixture.finalize(null);
  const includedWithoutFinality = await mockRpc('11155111', fixture.respond).verifier.verify(
    signal(),
  );
  assert.equal(includedWithoutFinality.state, 'pending');
  assert.equal(includedWithoutFinality.transfersComplete, true);
  assert.equal(includedWithoutFinality.transfers.length, 1);
});

test('Solana account creation and nonce withdrawals keep exact instruction movements and owner evidence', async () => {
  const fixture = solFixture();
  const instructions = [
    {
      programId: '11111111111111111111111111111111',
      parsed: {
        type: 'createAccount',
        info: {
          source: SOL_FROM,
          newAccount: SOL_TO,
          lamports: '500',
          owner: CLASSIC_SPL_TOKEN_PROGRAM,
        },
      },
    },
    {
      programId: '11111111111111111111111111111111',
      parsed: {
        type: 'createAccountWithSeed',
        info: {
          source: SOL_FROM,
          newAccount: TOKEN_FROM,
          lamports: '700',
          owner: '11111111111111111111111111111111',
        },
      },
    },
    {
      programId: '11111111111111111111111111111111',
      parsed: {
        type: 'withdrawFromNonce',
        info: {
          nonceAccount: SOL_FROM,
          destination: SOL_TO,
          lamports: '9007199254740999',
        },
      },
    },
    {
      programId: '11111111111111111111111111111111',
      parsed: {
        type: 'createAccountAllowPrefund',
        info: {
          newAccount: TOKEN_TO,
          owner: CLASSIC_SPL_TOKEN_PROGRAM,
        },
      },
    },
  ];
  const tx = {
    ...fixture.tx,
    transaction: {
      ...fixture.tx.transaction,
      message: { ...fixture.tx.transaction.message, instructions },
    },
    meta: { ...fixture.tx.meta, innerInstructions: [] },
  };
  const mocked = mockRpc(GENESIS, (method, params) => {
    if (method === 'getTransaction') return tx;
    if (method === 'getAccountInfo')
      return {
        context: { slot: 101 },
        value: {
          owner:
            params[0] === SOL_TO ? CLASSIC_SPL_TOKEN_PROGRAM : '11111111111111111111111111111111',
        },
      };
    return fixture.respond(method);
  });
  const output = await mocked.verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(output.state, 'finalized');
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['500', '700', '9007199254740999'],
  );
  assert.equal(output.transfers[0].destinationOwnerProgram, CLASSIC_SPL_TOKEN_PROGRAM);
  assert.equal(output.transfers[1].destinationOwnerProgram, '11111111111111111111111111111111');
  assert.equal(output.transfers[2].from, SOL_FROM);
  const ownerLookups = mocked.calls.filter((call) => call.method === 'getAccountInfo');
  assert.equal(ownerLookups.length, 2);
  assert.deepEqual(ownerLookups[0].params[1], {
    commitment: 'finalized',
    encoding: 'base64',
    minContextSlot: 101,
  });
});

test('Solana account ownership needs a finalized context and missing accounts never imply spendability', async () => {
  const fixture = solFixture();
  const missing = mockRpc(GENESIS, (method) =>
    method === 'getAccountInfo' ? { context: { slot: 101 }, value: null } : fixture.respond(method),
  );
  const output = await missing.verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(output.transfers[0].destinationOwnerProgram, undefined);
  const stale = mockRpc(GENESIS, (method) =>
    method === 'getAccountInfo'
      ? { context: { slot: 100 }, value: { owner: '11111111111111111111111111111111' } }
      : fixture.respond(method),
  );
  await assert.rejects(
    stale.verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /context predates/,
  );
  const unsupported = {
    ...fixture.tx,
    transaction: {
      ...fixture.tx.transaction,
      message: {
        ...fixture.tx.transaction.message,
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: { type: 'unknownLamportMove', info: {} },
          },
        ],
      },
    },
  };
  await assert.rejects(
    mockRpc(GENESIS, (method) =>
      method === 'getTransaction' ? unsupported : fixture.respond(method),
    ).verifier.verify(signal('solana', GENESIS, SIGNATURE)),
    /unsupported System Program/,
  );
});

test('unattributed Sol program movements never assert a complete native transfer set', async () => {
  const fixture = solFixture();
  const tx = {
    ...fixture.tx,
    transaction: {
      ...fixture.tx.transaction,
      message: {
        ...fixture.tx.transaction.message,
        instructions: [
          ...fixture.tx.transaction.message.instructions,
          { programId: MINT, accounts: [SOL_FROM, SOL_TO], data: 'opaque' },
        ],
      },
    },
  };
  const output = await mockRpc(GENESIS, (method) =>
    method === 'getTransaction' ? tx : fixture.respond(method),
  ).verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(output.state, 'finalized');
  assert.equal(output.transfersComplete, false);
  assert.deepEqual(
    output.transfers.map((transfer) => transfer.amount),
    ['17', '9007199254740999', '19'],
  );
});

test('known ComputeBudget and Memo instructions preserve complete native transfer attribution', async () => {
  const fixture = solFixture();
  const tx = {
    ...fixture.tx,
    transaction: {
      ...fixture.tx.transaction,
      message: {
        ...fixture.tx.transaction.message,
        instructions: [
          ...fixture.tx.transaction.message.instructions,
          {
            programId: 'ComputeBudget111111111111111111111111111111',
            data: 'budget',
            accounts: [],
          },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: 'memo' },
          { programId: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', data: 'memo', accounts: [] },
        ],
      },
    },
  };
  const output = await mockRpc(GENESIS, (method) =>
    method === 'getTransaction' ? tx : fixture.respond(method),
  ).verifier.verify(signal('solana', GENESIS, SIGNATURE));
  assert.equal(output.state, 'finalized');
  assert.equal(output.transfersComplete, true);
  assert.equal(output.transfers.length, 3);
});
