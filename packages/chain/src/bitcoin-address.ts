import { BadRequestException } from '@nestjs/common';
import { bech32 } from 'bech32';

// Wallet Core's legacy Bitcoin signer only accepts its coin's `bc` HRP. The
// witness script is network-neutral; recoding the same program for that input
// preserves the exact destination script while application addresses retain their selected HRP.
export function bitcoinWitnessAddress(address: string, network: string) {
  const prefix = network === 'regtest' ? 'bcrt' : network === 'testnet' ? 'tb' : undefined;
  try {
    const decoded = bech32.decode(address, 90);
    const program = bech32.fromWords(decoded.words.slice(1));
    if (
      !prefix ||
      decoded.prefix !== prefix ||
      decoded.words[0] !== 0 ||
      ![20, 32].includes(program.length)
    )
      throw new Error('Unsupported witness address');
    return {
      address: bech32.encode(prefix, decoded.words),
      signingAddress: bech32.encode('bc', decoded.words),
      program: Uint8Array.from(program),
    };
  } catch {
    throw new BadRequestException(`Invalid Bitcoin ${network} SegWit v0 address`);
  }
}

export function regtestWitnessAddress(address: string) {
  return bitcoinWitnessAddress(address, 'regtest');
}
