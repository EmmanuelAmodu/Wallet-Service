import { BadRequestException } from '@nestjs/common';
import { initWasm, TW, WalletCore } from '@trustwallet/wallet-core';
import { readFileSync, statSync } from 'node:fs';
import { walletCoreMetadata } from '../../../../packages/chain/src/coin-metadata.js';
import { ChainNetworkMap, networkFor } from '../../../../packages/chain/src/config.js';
import { regtestWitnessAddress } from '../../../../packages/chain/src/bitcoin-address.js';
import {
  DeriveRequest,
  BitcoinChain,
  EvmChain,
  SignedTransaction,
  SignRequest,
  SolanaChain,
  signSchema,
  deriveSchema,
  isEvmChain,
} from '../../../../packages/shared/src/contracts.js';
export type SignerDerivationPolicy = { domainId: string; chainNetworks: ChainNetworkMap };

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
    readonly ethereumChainIds: Record<string, string>,
    readonly policy?: SignerDerivationPolicy,
  ) {}

  static async fromFile(
    path: string,
    seedId: string,
    ethereumChainId: string,
    ethereumChainIds: Record<string, string> = { ethereum: ethereumChainId },
    policy?: SignerDerivationPolicy,
  ) {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('Seed file must be a regular file with mode 0600 or stricter');
    return this.create(
      readFileSync(path, 'utf8').trim(),
      seedId,
      ethereumChainId,
      ethereumChainIds,
      policy,
    );
  }

  static async create(
    mnemonic: string,
    seedId: string,
    ethereumChainId: string,
    ethereumChainIds: Record<string, string> = { ethereum: ethereumChainId },
    policy?: SignerDerivationPolicy,
  ) {
    const core = await initWasm();
    if (!core.Mnemonic.isValid(mnemonic)) throw new Error('Invalid BIP39 mnemonic');
    return new SigningCore(
      core,
      core.HDWallet.createWithMnemonic(mnemonic, ''),
      seedId,
      ethereumChainId,
      ethereumChainIds,
      policy,
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
    fn: (key: ReturnType<typeof this.hd.getKey>, address: string, path: string) => T,
  ): T {
    request = deriveSchema.parse(request);
    if (request.seedId !== this.seedId) throw new BadRequestException('Unknown seed ID');
    const network = this.network(request.chain);
    const { coin, path } = walletCoreMetadata(this.core, request.chain, request.account, network);
    const key = this.hd.getKey(coin, path);
    try {
      if (request.chain === 'bitcoin' && network === 'regtest') {
        const publicKey = key.getPublicKeySecp256k1(true);
        try {
          const address = this.core.AnyAddress.createBech32WithPublicKey(publicKey, coin, 'bcrt');
          try {
            return fn(key, regtestWitnessAddress(address.description()).address, path);
          } finally {
            address.delete();
          }
        } finally {
          publicKey.delete();
        }
      }
      return fn(key, this.core.CoinTypeExt.deriveAddress(coin, key), path);
    } finally {
      key.delete();
    }
  }

  network(chain: DeriveRequest['chain']) {
    if (this.policy)
      return networkFor(chain, {
        ethereumChainId: this.ethereumChainId,
        solanaGenesisHash: 'devnet',
        chainNetworks: this.policy.chainNetworks,
      });
    if (chain === 'bitcoin') return 'mainnet';
    if (chain === 'solana') return 'devnet';
    return this.ethereumChainIds[chain] ?? 'mainnet';
  }

  validateDerivation(domainId: string, network: string, path: string, request: DeriveRequest) {
    if (!this.policy || domainId !== this.policy.domainId)
      throw new BadRequestException('Custody domain is not configured for this signer');
    if (network !== this.network(request.chain))
      throw new BadRequestException('Derivation network is not configured for this signer');
    if (path !== walletCoreMetadata(this.core, request.chain, request.account, network).path)
      throw new BadRequestException('Derivation path does not match its account and network');
  }

  derive(request: DeriveRequest) {
    return this.withKey(request, (_, address, path) => ({
      ...request,
      address,
      path,
    }));
  }

  sign(request: SignRequest): SignedTransaction {
    request = signSchema.parse(request);
    const network = this.network(request.wallet.chain);
    if (
      (request.wallet.network !== undefined && request.wallet.network !== network) ||
      (request.wallet.chain === 'bitcoin' &&
        network === 'regtest' &&
        request.wallet.network === undefined)
    )
      throw new BadRequestException('Signing wallet network does not match signer configuration');
    const { address: requestedAddress, network: _network, ...derivation } = request.wallet;
    return this.withKey(derivation, (key, address) => {
      if (
        (isEvmChain(request.wallet.chain) ? address.toLowerCase() : address) !==
        (isEvmChain(request.wallet.chain) ? requestedAddress.toLowerCase() : requestedAddress)
      )
        throw new BadRequestException('Wallet address does not match derivation');
      const privateKey = key.data();
      try {
        const tx = request.transaction;
        if ('to' in tx) return this.signEthereum(tx, privateKey);
        if ('utxos' in tx) return this.signBitcoin(tx, request.wallet.address, privateKey);
        return this.signSolana(tx, request.wallet.address, privateKey);
      } finally {
        privateKey.fill(0);
      }
    });
  }

  private signEthereum(
    tx: Extract<SignRequest['transaction'], { chain: EvmChain }>,
    privateKey: Uint8Array,
  ): SignedTransaction {
    this.assertValidAddress(tx.to, tx.chain);
    if (tx.chainId !== this.ethereumChainIds[tx.chain])
      throw new BadRequestException('EVM chain ID not permitted');
    if (BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas))
      throw new BadRequestException('Priority fee exceeds max fee');

    const proto = TW.Ethereum.Proto;
    const coin = this.coin(tx.chain);
    const encodedInput = proto.SigningInput.encode({
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
    try {
      const output = proto.SigningOutput.decode(this.core.AnySigner.sign(encodedInput, coin));
      this.check(output.error, output.encoded.length);
      return {
        raw: '0x' + Buffer.from(output.encoded).toString('hex'),
        txHash: '0x' + Buffer.from(this.core.Hash.keccak256(output.encoded)).toString('hex'),
        encoding: 'hex',
      };
    } finally {
      encodedInput.fill(0);
    }
  }

  private signBitcoin(
    tx: Extract<SignRequest['transaction'], { chain: BitcoinChain }>,
    address: string,
    privateKey: Uint8Array,
  ): SignedTransaction {
    const regtest = tx.chain === 'bitcoin' && this.network(tx.chain) === 'regtest';
    const signingAddress = (value: string) =>
      regtest ? regtestWitnessAddress(value).signingAddress : value;
    tx.outputs.forEach((output) => this.assertValidAddress(output.address, tx.chain));
    if (new Set(tx.utxos.map((utxo) => `${utxo.txid}:${utxo.vout}`)).size !== tx.utxos.length)
      throw new BadRequestException('Duplicate UTXO');

    const coin = this.coin(tx.chain);
    const script = this.core.BitcoinScript.lockScriptForAddress(signingAddress(address), coin);
    let ownScript: string;
    try {
      ownScript = Buffer.from(script.data()).toString('hex');
    } finally {
      script.delete();
    }
    if (tx.utxos.some((utxo) => utxo.script !== ownScript))
      throw new BadRequestException('UTXO is not owned by this wallet');

    const proto = TW.Bitcoin.Proto;
    const input = proto.SigningInput.fromObject({
      privateKey: [privateKey],
      coinType: coin.value,
      hashType: this.core.BitcoinScript.hashTypeForCoin(coin),
      amount: tx.outputs[0].amount,
      toAddress: signingAddress(tx.outputs[0].address),
      changeAddress: signingAddress(address),
      byteFee: String(tx.satsPerVbyte),
      useMaxUtxo: true,
      extraOutputs: tx.outputs
        .slice(1)
        .map((output) => ({ toAddress: signingAddress(output.address), amount: output.amount })),
      utxo: tx.utxos.map((utxo) => ({
        amount: utxo.amount,
        script: Buffer.from(utxo.script, 'hex'),
        outPoint: {
          hash: Buffer.from(utxo.txid, 'hex').reverse(),
          index: utxo.vout,
          sequence: 0xffffffff,
        },
      })),
    });
    const encodedInput = proto.SigningInput.encode(input).finish();
    try {
      const output = proto.SigningOutput.decode(this.core.AnySigner.sign(encodedInput, coin));
      this.check(output.error, output.encoded.length);
      return {
        raw: Buffer.from(output.encoded).toString('hex'),
        txHash: output.transactionId,
        encoding: 'hex',
      };
    } finally {
      encodedInput.fill(0);
    }
  }

  private signSolana(
    tx: Extract<SignRequest['transaction'], { chain: SolanaChain }>,
    address: string,
    privateKey: Uint8Array,
  ): SignedTransaction {
    tx.outputs.forEach((output) => this.assertValidAddress(output.address, 'solana'));
    if (this.core.Base58.decodeNoCheck(tx.recentBlockhash).length !== 32)
      throw new BadRequestException('Invalid Solana blockhash');

    const proto = TW.Solana.Proto;
    const systemProgram = '11111111111111111111111111111111';
    if (tx.outputs.some((output) => output.address === systemProgram))
      throw new BadRequestException('System program cannot be a transfer recipient');

    const accounts = [
      address,
      ...new Set(tx.outputs.map((output) => output.address).filter((output) => output !== address)),
      systemProgram,
    ];
    const instructions = tx.outputs.map((output) => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(output.amount), 4);
      return {
        programId: accounts.length - 1,
        accounts: [0, accounts.indexOf(output.address)],
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
    const encodedInput = proto.SigningInput.encode(input).finish();
    try {
      const output = proto.SigningOutput.decode(
        this.core.AnySigner.sign(encodedInput, this.coin('solana')),
      );
      this.check(output.error, output.encoded.length);
      const raw = Buffer.from(output.encoded, 'base64');
      if (raw.length > 1232)
        throw new BadRequestException('Solana transaction exceeds legacy packet limit');
      if (raw[0] !== 1) throw new BadRequestException('Unexpected Solana signature count');
      return {
        raw: output.encoded,
        txHash: this.core.Base58.encodeNoCheck(raw.subarray(1, 65)),
        encoding: 'base64',
      };
    } finally {
      encodedInput.fill(0);
    }
  }

  private assertValidAddress(address: string, chain: DeriveRequest['chain']) {
    if (chain === 'bitcoin' && this.network(chain) === 'regtest') {
      regtestWitnessAddress(address);
      return;
    }
    if (!this.core.AnyAddress.isValid(address, this.coin(chain)))
      throw new BadRequestException('Invalid recipient address');
  }

  private check(error: number, size: number) {
    if (error !== 0 || size === 0)
      throw new BadRequestException(`Wallet Core could not sign transaction (code ${error})`);
  }
}
