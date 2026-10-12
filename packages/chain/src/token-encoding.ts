import { createPublicKey, verify } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  CLASSIC_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  TokenSignRequest,
} from '../../shared/src/token-contracts.js';
import { SignedTransaction } from '../../shared/src/contracts.js';
import { Transaction } from 'ethers';
import { TW } from '@trustwallet/wallet-core';
import { getWalletCore } from './coin-metadata.js';
import { assertEvmExternalAddress, assertSolanaExternalAddress } from './recipient-policy.js';

export function erc20TransferData(recipient: string, amount: string): string {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(recipient) ||
    !/^[1-9][0-9]{0,77}$/.test(amount) ||
    BigInt(amount) >= 1n << 256n
  )
    throw new Error('Invalid ERC-20 transfer');
  return (
    '0xa9059cbb' +
    recipient.slice(2).toLowerCase().padStart(64, '0') +
    BigInt(amount).toString(16).padStart(64, '0')
  );
}

export function verifySignedErc20Transfer(request: TokenSignRequest, signed: SignedTransaction) {
  if (request.transaction.kind !== 'erc20' || signed.encoding !== 'hex')
    throw new Error('Not an ERC-20 signed transfer');
  const expected = request.transaction,
    decoded = Transaction.from(signed.raw);
  assertEvmExternalAddress(expected.recipient);
  if (
    !decoded.isSigned() ||
    decoded.type !== 2 ||
    decoded.hash !== signed.txHash ||
    decoded.from?.toLowerCase() !== request.wallet.address.toLowerCase() ||
    decoded.to?.toLowerCase() !== expected.contract ||
    decoded.value !== 0n ||
    decoded.data !== erc20TransferData(expected.recipient, expected.amount) ||
    decoded.chainId.toString() !== expected.chainId ||
    BigInt(decoded.nonce).toString() !== expected.nonce ||
    decoded.gasLimit.toString() !== expected.gasLimit ||
    decoded.maxFeePerGas?.toString() !== expected.maxFeePerGas ||
    decoded.maxPriorityFeePerGas?.toString() !== expected.maxPriorityFeePerGas ||
    decoded.accessList?.length !== 0
  )
    throw new Error('Signed ERC-20 transfer mismatch');
  return decoded;
}

export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const core = await getWalletCore();
  for (const address of [owner, mint])
    if (!core.AnyAddress.isValid(address, core.CoinType.solana))
      throw new Error('Invalid Solana token address');
  const address = core.SolanaAddress.createWithString(owner);
  try {
    return address.defaultTokenAddress(mint);
  } finally {
    address.delete();
  }
}

/** Installed Wallet Core's exact signable message, compiled without secret material. */
export async function splTransferMessage(request: TokenSignRequest): Promise<Buffer> {
  if (request.transaction.kind !== 'spl') throw new Error('Not an SPL transfer');
  const core = await getWalletCore(),
    tx = request.transaction,
    proto = TW.Solana.Proto;
  const transfer = {
    tokenMintAddress: tx.mint,
    senderTokenAddress: tx.sourceTokenAccount,
    recipientTokenAddress: tx.recipientTokenAccount,
    amount: tx.amount,
    decimals: tx.decimals,
    tokenProgramId: proto.TokenProgramId.TokenProgram,
  };
  const input = proto.SigningInput.encode(
    proto.SigningInput.fromObject({
      sender: request.wallet.address,
      recentBlockhash: tx.recentBlockhash,
      ...(tx.feePayer.address !== request.wallet.address ? { feePayer: tx.feePayer.address } : {}),
      ...(tx.createRecipientAccount
        ? {
            createAndTransferTokenTransaction: {
              ...transfer,
              recipientMainAddress: tx.recipientOwner,
            },
          }
        : { tokenTransferTransaction: transfer }),
    }),
  ).finish();
  const output = proto.PreSigningOutput.decode(
    core.TransactionCompiler.preImageHashes(core.CoinType.solana, input),
  );
  if (output.error !== 0 || !output.data.length) throw new Error('SPL message compilation failed');
  return Buffer.from(output.data);
}

export interface LegacySolanaTransaction {
  signatures: Buffer[];
  message: Buffer;
  requiredSignatures: number;
  readonlySigned: number;
  readonlyUnsigned: number;
  keys: Buffer[];
  recentBlockhash: Buffer;
  instructions: { program: number; accounts: number[]; data: Buffer }[];
}

/** Bounded independent wire decoder; never accept lookup tables, trailing data or overlong shortvecs. */
export function decodeLegacySolanaTransaction(
  encoded: string,
  maxInstructions = 2,
): LegacySolanaTransaction {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded || raw.length > 1232)
    throw new Error('Invalid Solana packet');
  let cursor = 0;
  const read = (size: number) => {
    if (size < 0 || cursor + size > raw.length) throw new Error('Truncated Solana packet');
    const result = raw.subarray(cursor, cursor + size);
    cursor += size;
    return result;
  };
  const count = () => {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = read(1)[0];
      value |= (byte & 127) << (i * 7);
      if (!(byte & 128)) {
        if ((i > 0 && byte === 0) || value > 65535) throw new Error('Noncanonical shortvec');
        return value;
      }
    }
    throw new Error('Invalid shortvec');
  };
  const signatureCount = count();
  if (signatureCount < 1 || signatureCount > 2) throw new Error('Unexpected token signature count');
  const signatures = Array.from({ length: signatureCount }, () => read(64));
  const messageStart = cursor;
  const [requiredSignatures, readonlySigned, readonlyUnsigned] = read(3);
  if (requiredSignatures !== signatureCount || readonlySigned >= requiredSignatures)
    throw new Error('Invalid legacy Solana header');
  const keyCount = count();
  if (
    keyCount < requiredSignatures ||
    keyCount > 32 ||
    readonlyUnsigned > keyCount - requiredSignatures
  )
    throw new Error('Invalid Solana key count');
  const keys = Array.from({ length: keyCount }, () => read(32));
  if (new Set(keys.map((key) => key.toString('hex'))).size !== keys.length)
    throw new Error('Duplicate Solana message key');
  const recentBlockhash = read(32);
  const instructionCount = count();
  if (instructionCount < 1 || instructionCount > maxInstructions)
    throw new Error('Unexpected token instructions');
  const instructions = Array.from({ length: instructionCount }, () => {
    const program = read(1)[0],
      accounts = [...read(count())],
      data = read(count());
    if (program >= keyCount || accounts.some((index) => index >= keyCount))
      throw new Error('Invalid Solana instruction index');
    return { program, accounts, data };
  });
  if (cursor !== raw.length) throw new Error('Trailing Solana transaction bytes');
  return {
    signatures,
    message: raw.subarray(messageStart),
    requiredSignatures,
    readonlySigned,
    readonlyUnsigned,
    keys,
    recentBlockhash,
    instructions,
  };
}

/** Validate fee payer, both independent signatures, exact checked transfer and optional ATA creation. */
export async function verifySignedSplTransfer(
  request: TokenSignRequest,
  signed: SignedTransaction,
): Promise<LegacySolanaTransaction> {
  if (request.transaction.kind !== 'spl' || signed.encoding !== 'base64')
    throw new Error('Not an SPL signed transfer');
  const tx = request.transaction,
    core = await getWalletCore();
  await assertSolanaExternalAddress(tx.recipientOwner);
  const decoded = decodeLegacySolanaTransaction(signed.raw);
  const keyStrings = decoded.keys.map((key) => core.Base58.encodeNoCheck(key));
  const authority = request.wallet.address,
    payer = tx.feePayer.address;
  const signers = payer === authority ? [payer] : [payer, authority];
  if (
    decoded.requiredSignatures !== signers.length ||
    signers.some((key, index) => keyStrings[index] !== key) ||
    core.Base58.encodeNoCheck(decoded.recentBlockhash) !== tx.recentBlockhash ||
    signed.txHash !== core.Base58.encodeNoCheck(decoded.signatures[0])
  )
    throw new Error('SPL signed identity mismatch');
  for (let i = 0; i < signers.length; i++) {
    const publicKey = createPublicKey({
      format: 'der',
      type: 'spki',
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decoded.keys[i]]),
    });
    if (!verify(null, decoded.message, publicKey, decoded.signatures[i]))
      throw new Error('Invalid SPL transaction signature');
  }
  if (tx.recipientTokenAccount !== (await associatedTokenAddress(tx.recipientOwner, tx.mint)))
    throw new Error('SPL recipient is not the owner associated token account');
  const rent = 'SysvarRent111111111111111111111111111111111';
  const expectedKeys = new Set([
    payer,
    authority,
    tx.sourceTokenAccount,
    tx.recipientTokenAccount,
    tx.mint,
    CLASSIC_TOKEN_PROGRAM,
    ...(tx.createRecipientAccount
      ? [tx.recipientOwner, SOLANA_SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]
      : []),
  ]);
  // Older Wallet Core builds include the readonly rent sysvar in ATA creation.
  if (tx.createRecipientAccount && keyStrings.includes(rent)) expectedKeys.add(rent);
  if (keyStrings.length !== expectedKeys.size || keyStrings.some((key) => !expectedKeys.has(key)))
    throw new Error('Unexpected SPL message account');
  const writable = (key: string) => {
    const i = keyStrings.indexOf(key);
    return (
      i >= 0 &&
      (i < decoded.requiredSignatures
        ? i < decoded.requiredSignatures - decoded.readonlySigned
        : i < keyStrings.length - decoded.readonlyUnsigned)
    );
  };
  if (
    ![payer, tx.sourceTokenAccount, tx.recipientTokenAccount].every(writable) ||
    [
      CLASSIC_TOKEN_PROGRAM,
      tx.mint,
      ...(tx.createRecipientAccount
        ? [
            ASSOCIATED_TOKEN_PROGRAM,
            SOLANA_SYSTEM_PROGRAM,
            ...(expectedKeys.has(rent) ? [rent] : []),
          ]
        : []),
    ].some(writable)
  )
    throw new Error('SPL account permissions mismatch');
  if (decoded.instructions.length !== (tx.createRecipientAccount ? 2 : 1))
    throw new Error('SPL instruction count mismatch');
  const transfer = decoded.instructions.at(-1)!;
  const accounts = transfer.accounts.map((index) => keyStrings[index]);
  if (
    keyStrings[transfer.program] !== CLASSIC_TOKEN_PROGRAM ||
    accounts.length !== 4 ||
    accounts.join('|') !==
      [tx.sourceTokenAccount, tx.mint, tx.recipientTokenAccount, authority].join('|') ||
    transfer.data.length !== 10 ||
    transfer.data[0] !== 12 ||
    transfer.data.readBigUInt64LE(1).toString() !== tx.amount ||
    transfer.data[9] !== tx.decimals
  )
    throw new Error('SPL checked transfer mismatch');
  if (tx.createRecipientAccount) {
    const creation = decoded.instructions[0];
    const actual = creation.accounts.map((index) => keyStrings[index]);
    const expected = [
      payer,
      tx.recipientTokenAccount,
      tx.recipientOwner,
      tx.mint,
      SOLANA_SYSTEM_PROGRAM,
      CLASSIC_TOKEN_PROGRAM,
    ];
    if (actual.length === 7) expected.push(rent);
    if (
      keyStrings[creation.program] !== ASSOCIATED_TOKEN_PROGRAM ||
      actual.join('|') !== expected.join('|') ||
      !(creation.data.length === 0 || (creation.data.length === 1 && creation.data[0] === 1))
    )
      throw new Error('SPL account creation mismatch');
  }
  return decoded;
}
