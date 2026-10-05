import { BadRequestException } from '@nestjs/common';
import { bech32 } from 'bech32';

// Wallet Core's legacy Bitcoin signer only accepts its coin's `bc` HRP. The
// witness script is network-neutral; recoding the same program for that input
// preserves the exact destination script while all application addresses remain bcrt.
export function regtestWitnessAddress(address: string) {
  try {
    const decoded = bech32.decode(address, 90);
    const program = bech32.fromWords(decoded.words.slice(1));
    if (decoded.prefix !== 'bcrt' || decoded.words[0] !== 0 || ![20, 32].includes(program.length))
      throw new Error('Unsupported witness address');
    return {
      address: bech32.encode('bcrt', decoded.words),
      signingAddress: bech32.encode('bc', decoded.words),
      program: Uint8Array.from(program),
    };
  } catch {
    throw new BadRequestException('Invalid Bitcoin regtest SegWit v0 address');
  }
}
