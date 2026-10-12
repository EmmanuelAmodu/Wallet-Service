import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { signSchema } from '../packages/shared/src/contracts.js';
import {
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_DEVNET,
  TokenSignRequest,
  tokenSignRequestSchema,
  tokenCertificateSchema,
} from '../packages/shared/src/token-contracts.js';
import {
  associatedTokenAddress,
  decodeLegacySolanaTransaction,
  verifySignedErc20Transfer,
  verifySignedSplTransfer,
  splTransferMessage,
} from '../packages/chain/src/token-encoding.js';
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let core: SigningCore;
before(async () => {
  core = await SigningCore.create(mnemonic, 'capability-fixture', '11155111', undefined, {
    domainId: 'exchange',
    chainNetworks: {
      ethereum: { network: '11155111', chainId: '11155111' },
      solana: { network: SOLANA_DEVNET, genesisHash: SOLANA_DEVNET },
    },
  });
});
after(() => core.close());

function wallet(chain: 'ethereum' | 'solana', account: number) {
  const derived = core.derive({ chain, account, seedId: core.seedId });
  return {
    chain,
    account,
    seedId: core.seedId,
    address: derived.address,
    network: chain === 'ethereum' ? '11155111' : SOLANA_DEVNET,
  };
}

function erc20(): TokenSignRequest {
  return tokenSignRequestSchema.parse({
    wallet: wallet('ethereum', 10),
    transaction: {
      kind: 'erc20',
      chain: 'ethereum',
      chainId: '11155111',
      contract: '0x' + '12'.repeat(20),
      recipient: wallet('ethereum', 0).address,
      amount: '123456789012345678901234567890',
      nonce: '19',
      gasLimit: '65000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
    },
  });
}

async function spl(createRecipientAccount = false, withdrawal = false): Promise<TokenSignRequest> {
  const source = wallet('solana', withdrawal ? 0 : 10),
    payer = wallet('solana', withdrawal ? 0 : 1),
    recipient = wallet('solana', withdrawal ? 11 : 0),
    mint = wallet('solana', 8).address;
  return tokenSignRequestSchema.parse({
    wallet: source,
    transaction: {
      kind: 'spl',
      chain: 'solana',
      mint,
      programId: CLASSIC_TOKEN_PROGRAM,
      sourceTokenAccount: await associatedTokenAddress(source.address, mint),
      recipientOwner: recipient.address,
      recipientTokenAccount: await associatedTokenAddress(recipient.address, mint),
      amount: '9007199254740993',
      decimals: 6,
      createRecipientAccount,
      recentBlockhash: wallet('solana', 9).address,
      lastValidBlockHeight: 12345,
      feePayer: payer,
      accountClosure: 'retain',
    },
  });
}

test('installed Wallet Core signs an exact ERC-20 transfer, distinct contract/recipient and zero ETH', async () => {
  const request = erc20(),
    signed = await core.signToken(request);
  const decoded = verifySignedErc20Transfer(request, signed);
  assert.equal(decoded.nonce, 19);
  assert.equal(decoded.value, 0n);
  assert.ok(!signSchema.safeParse(request).success, 'native queue schema must reject token input');
  const modified = structuredClone(request);
  if (modified.transaction.kind === 'erc20') modified.transaction.amount = '1';
  assert.throws(() => verifySignedErc20Transfer(modified, signed), /mismatch/);
});

for (const create of [false, true]) {
  test(`installed Wallet Core supports management1-sponsored SPL with ${create ? 'new' : 'existing'} hot ATA and two verified signatures`, async () => {
    const request = await spl(create),
      signed = await core.signToken(request);
    const decoded = await verifySignedSplTransfer(request, signed);
    assert.ok(decoded.message.equals(await splTransferMessage(request)));
    assert.equal(decoded.requiredSignatures, 2);
    assert.equal(decoded.instructions.length, create ? 2 : 1);
    const corrupted = Buffer.from(signed.raw, 'base64');
    corrupted[65] ^= 1;
    await assert.rejects(
      verifySignedSplTransfer(request, { ...signed, raw: corrupted.toString('base64') }),
      /signature/,
    );
    assert.ok(!signSchema.safeParse(request).success);
  });
}

test('installed Wallet Core supports one-signature hot0 SPL withdrawal without sponsor substitution', async () => {
  const request = await spl(false, true),
    signed = await core.signToken(request);
  assert.equal((await verifySignedSplTransfer(request, signed)).requiredSignatures, 1);
  const rebound = structuredClone(request);
  if (rebound.transaction.kind === 'spl')
    rebound.transaction.feePayer = { ...wallet('solana', 1), chain: 'solana', account: 1 };
  assert.ok(!tokenSignRequestSchema.safeParse(rebound).success);
});

test('token primitives reject wrong derivation, arbitrary calldata, recipient ATA, unsupported programs and closure', async () => {
  const eth = erc20();
  eth.wallet.account = 11;
  await assert.rejects(core.signToken(eth), /derivation/);
  const sol = await spl();
  if (sol.transaction.kind !== 'spl') throw new Error('fixture');
  sol.transaction.recipientTokenAccount = sol.transaction.sourceTokenAccount;
  await assert.rejects(core.signToken(sol), /associated/);
  const valid = await spl();
  assert.ok(
    !tokenSignRequestSchema.safeParse({
      ...valid,
      transaction: {
        ...valid.transaction,
        programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      },
    }).success,
  );
  assert.ok(
    !tokenSignRequestSchema.safeParse({
      ...valid,
      transaction: { ...valid.transaction, accountClosure: 'close' },
    }).success,
  );
  assert.ok(
    !tokenSignRequestSchema.safeParse({
      ...erc20(),
      transaction: { ...erc20().transaction, data: '0xdeadbeef' },
    }).success,
  );
  assert.ok(
    !tokenCertificateSchema.safeParse({
      standard: 'erc20',
      chain: 'ethereum',
      network: '11155111',
      certificateId: 'unverified',
      semantics: 'fee-on-transfer',
      decimals: 6,
      contract: '0x' + '12'.repeat(20),
      runtimeCodeHash: '0x' + '00'.repeat(32),
      upgradePolicy: 'immutable',
    }).success,
  );
});

test('independent SPL decoder rejects truncation, trailing bytes, noncanonical counts and changed instruction data', async () => {
  const request = await spl(),
    signed = await core.signToken(request);
  const raw = Buffer.from(signed.raw, 'base64');
  assert.throws(() => decodeLegacySolanaTransaction(raw.subarray(0, -1).toString('base64')));
  assert.throws(() =>
    decodeLegacySolanaTransaction(Buffer.concat([raw, Buffer.from([0])]).toString('base64')),
  );
  assert.throws(() =>
    decodeLegacySolanaTransaction(
      Buffer.concat([Buffer.from([130, 0]), raw.subarray(1)]).toString('base64'),
    ),
  );
  raw[raw.length - 1] ^= 1;
  await assert.rejects(
    verifySignedSplTransfer(request, { ...signed, raw: raw.toString('base64') }),
    /signature/,
  );
});
