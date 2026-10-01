import { BadRequestException } from '@nestjs/common';
import { initWasm, TW, WalletCore } from '@trustwallet/wallet-core';
import { readFileSync, statSync } from 'node:fs';
import {
  DeriveRequest,
  derivationPath,
  SignedTransaction,
  SignRequest,
  signSchema,
} from '../../../../packages/shared/src/contracts';

function bytes(value: string): Uint8Array {
  const n = BigInt(value);
  if (n === 0n) return new Uint8Array();
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
export class SigningCore {
  private constructor(
    private readonly core: WalletCore,
    private readonly hd: ReturnType<WalletCore['HDWallet']['createWithMnemonic']>,
    readonly seedId: string,
    readonly ethereumChainId: string,
  ) {}
  static async fromFile(path: string, seedId: string, ethereumChainId: string) {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('Seed file must be a regular file with mode 0600 or stricter');
    return this.create(readFileSync(path, 'utf8').trim(), seedId, ethereumChainId);
  }
  static async create(mnemonic: string, seedId: string, ethereumChainId: string) {
    const core = await initWasm();
    if (!core.Mnemonic.isValid(mnemonic)) throw new Error('Invalid BIP39 mnemonic');
    return new SigningCore(
      core,
      core.HDWallet.createWithMnemonic(mnemonic, ''),
      seedId,
      ethereumChainId,
    );
  }
  close() {
    this.hd.delete();
  }
  private coin(chain: DeriveRequest['chain']) {
    return this.core.CoinType[chain];
  }
  private withKey<T>(
    request: DeriveRequest,
    fn: (key: ReturnType<typeof this.hd.getKey>, address: string) => T,
  ): T {
    if (request.seedId !== this.seedId) throw new BadRequestException('Unknown seed ID');
    const key = this.hd.getKey(
      this.coin(request.chain),
      derivationPath(request.chain, request.account),
    );
    try {
      return fn(key, this.core.CoinTypeExt.deriveAddress(this.coin(request.chain), key));
    } finally {
      key.delete();
    }
  }
  derive(request: DeriveRequest) {
    return this.withKey(request, (_, address) => ({
      ...request,
      address,
      path: derivationPath(request.chain, request.account),
    }));
  }
  sign(request: SignRequest): SignedTransaction {
    request = signSchema.parse(request);
    return this.withKey(request.wallet, (key, address) => {
      if (address !== request.wallet.address)
        throw new BadRequestException('Wallet address does not match derivation');
      const tx = request.transaction;
      const coin = this.coin(tx.chain);
      const valid = (to: string) => {
        if (!this.core.AnyAddress.isValid(to, coin))
          throw new BadRequestException('Invalid recipient address');
      };
      const privateKey = key.data();
      let encodedInput: Uint8Array | undefined;
      try {
        if (tx.chain === 'ethereum') {
          valid(tx.to);
          if (tx.chainId !== this.ethereumChainId)
            throw new BadRequestException('Ethereum chain ID not permitted');
          if (BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas))
            throw new BadRequestException('Priority fee exceeds max fee');
          const proto = TW.Ethereum.Proto;
          encodedInput = proto.SigningInput.encode({
            privateKey,
            chainId: bytes(tx.chainId),
            nonce: bytes(tx.nonce),
            txMode: proto.TransactionMode.Enveloped,
            gasLimit: bytes(tx.gasLimit),
            maxFeePerGas: bytes(tx.maxFeePerGas),
            maxInclusionFeePerGas: bytes(tx.maxPriorityFeePerGas),
            toAddress: tx.to,
            transaction: { transfer: { amount: bytes(tx.amount) } },
          }).finish();
          const out = proto.SigningOutput.decode(this.core.AnySigner.sign(encodedInput, coin));
          this.check(out.error, out.encoded.length);
          return {
            raw: '0x' + Buffer.from(out.encoded).toString('hex'),
            txHash: '0x' + Buffer.from(this.core.Hash.keccak256(out.encoded)).toString('hex'),
            encoding: 'hex',
          };
        }
        if (tx.chain === 'bitcoin') {
          tx.outputs.forEach((o) => valid(o.address));
          if (new Set(tx.utxos.map((u) => `${u.txid}:${u.vout}`)).size !== tx.utxos.length)
            throw new BadRequestException('Duplicate UTXO');
          const script = this.core.BitcoinScript.lockScriptForAddress(address, coin);
          let ownScript: string;
          try {
            ownScript = Buffer.from(script.data()).toString('hex');
          } finally {
            script.delete();
          }
          if (tx.utxos.some((u) => u.script !== ownScript))
            throw new BadRequestException('UTXO is not owned by this wallet');
          const proto = TW.Bitcoin.Proto;
          const input = proto.SigningInput.fromObject({
            privateKey: [privateKey],
            coinType: 0,
            hashType: this.core.BitcoinScript.hashTypeForCoin(coin),
            amount: tx.outputs[0].amount,
            toAddress: tx.outputs[0].address,
            changeAddress: address,
            byteFee: String(tx.satsPerVbyte),
            useMaxUtxo: true,
            extraOutputs: tx.outputs
              .slice(1)
              .map((o) => ({ toAddress: o.address, amount: o.amount })),
            utxo: tx.utxos.map((u) => ({
              amount: u.amount,
              script: Buffer.from(u.script, 'hex'),
              outPoint: {
                hash: Buffer.from(u.txid, 'hex').reverse(),
                index: u.vout,
                sequence: 0xffffffff,
              },
            })),
          });
          encodedInput = proto.SigningInput.encode(input).finish();
          const out = proto.SigningOutput.decode(this.core.AnySigner.sign(encodedInput, coin));
          this.check(out.error, out.encoded.length);
          return {
            raw: Buffer.from(out.encoded).toString('hex'),
            txHash: out.transactionId,
            encoding: 'hex',
          };
        }
        tx.outputs.forEach((o) => valid(o.address));
        if (this.core.Base58.decodeNoCheck(tx.recentBlockhash).length !== 32)
          throw new BadRequestException('Invalid Solana blockhash');
        const proto = TW.Solana.Proto;
        const system = '11111111111111111111111111111111';
        if (tx.outputs.some((o) => o.address === system))
          throw new BadRequestException('System program cannot be a transfer recipient');
        const accounts = [
          address,
          ...new Set(tx.outputs.map((o) => o.address).filter((a) => a !== address)),
          system,
        ];
        const instructions = tx.outputs.map((o) => {
          const data = Buffer.alloc(12);
          data.writeUInt32LE(2, 0);
          data.writeBigUInt64LE(BigInt(o.amount), 4);
          return {
            programId: accounts.length - 1,
            accounts: [0, accounts.indexOf(o.address)],
            programData: data,
          };
        });
        const input = proto.SigningInput.fromObject({
          privateKey,
          txEncoding: proto.Encoding.Base64,
          rawMessage: {
            legacy: {
              header: {
                numRequiredSignatures: 1,
                numReadonlySignedAccounts: 0,
                numReadonlyUnsignedAccounts: 1,
              },
              accountKeys: accounts,
              recentBlockhash: tx.recentBlockhash,
              instructions,
            },
          },
        });
        encodedInput = proto.SigningInput.encode(input).finish();
        const out = proto.SigningOutput.decode(this.core.AnySigner.sign(encodedInput, coin));
        this.check(out.error, out.encoded.length);
        const raw = Buffer.from(out.encoded, 'base64');
        if (raw.length > 1232)
          throw new BadRequestException('Solana transaction exceeds legacy packet limit');
        if (raw[0] !== 1) throw new BadRequestException('Unexpected Solana signature count');
        return {
          raw: out.encoded,
          txHash: this.core.Base58.encodeNoCheck(raw.subarray(1, 65)),
          encoding: 'base64',
        };
      } finally {
        privateKey.fill(0);
        encodedInput?.fill(0);
      }
    });
  }
  private check(error: number, size: number) {
    if (error !== 0 || size === 0)
      throw new BadRequestException(`Wallet Core could not sign transaction (code ${error})`);
  }
}
