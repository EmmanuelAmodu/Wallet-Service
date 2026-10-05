import { BadRequestException } from '@nestjs/common';
import { initWasm, WalletCore } from '@trustwallet/wallet-core';
import { accountSchema, Chain, chainFamily } from '../../shared/src/contracts.js';
import { regtestWitnessAddress } from './bitcoin-address.js';

let corePromise: ReturnType<typeof initWasm> | undefined;

export function walletCoreMetadata(
  core: WalletCore,
  chain: Chain,
  account: number,
  network = 'mainnet',
) {
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
  if (chain === 'bitcoin') {
    if (!['mainnet', 'regtest'].includes(network))
      throw new BadRequestException('Unsupported Bitcoin network');
    if (network === 'regtest') path[2] = "1'";
  }
  return { coin, family, path: path.join('/') };
}

export async function getWalletCore() {
  corePromise ??= initWasm();
  return corePromise;
}

export async function coreDerivationPath(chain: Chain, account: number, network = 'mainnet') {
  const core = await getWalletCore();
  return walletCoreMetadata(core, chain, account, network).path;
}

export async function canonicalizeDerivedAddress(chain: Chain, network: string, address: string) {
  if (chain === 'bitcoin' && network === 'regtest') return regtestWitnessAddress(address).address;
  if (chain === 'bitcoin' && network !== 'mainnet')
    throw new BadRequestException('Unsupported Bitcoin network');
  const core = await getWalletCore();
  if (!core.AnyAddress.isValid(address, core.CoinType[chain]))
    throw new BadRequestException('Derived address is invalid for its chain and network');
  if (chain === 'bitcoin' && /^bc1/i.test(address)) return address.toLowerCase();
  return chainFamily(chain) === 'ethereum' ? address.toLowerCase() : address;
}
