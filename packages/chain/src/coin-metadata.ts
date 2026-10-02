import { BadRequestException } from '@nestjs/common';
import { initWasm, WalletCore } from '@trustwallet/wallet-core';
import { accountSchema, Chain, chainFamily } from '../../shared/src/contracts.js';

let corePromise: ReturnType<typeof initWasm> | undefined;

export function walletCoreMetadata(core: WalletCore, chain: Chain, account: number) {
  accountSchema.parse(account);
  const coin = core.CoinType[chain];
  const family = chainFamily(chain);
  const blockchain = core.CoinTypeExt.blockchain(coin).value;
  const expectedBlockchains =
    family === 'bitcoin'
      ? [
          core.Blockchain.bitcoin.value,
          ...(chain === 'bitcoinCash' || chain === 'ecash'
            ? [core.Blockchain.bitcoinCash.value]
            : []),
        ]
      : [core.Blockchain[family].value];
  if (!expectedBlockchains.includes(blockchain))
    throw new BadRequestException('Coin is not supported by its configured protocol family');

  const path = core.CoinTypeExt.derivationPath(coin).split('/');
  if (path.length < 4 || path[0] !== 'm' || !path[3].endsWith("'"))
    throw new BadRequestException('Wallet Core returned an unsupported derivation path');
  path[3] = `${account}'`;
  return { coin, family, path: path.join('/') };
}

export async function getWalletCore() {
  corePromise ??= initWasm();
  return corePromise;
}

export async function coreDerivationPath(chain: Chain, account: number) {
  const core = await getWalletCore();
  return walletCoreMetadata(core, chain, account).path;
}
