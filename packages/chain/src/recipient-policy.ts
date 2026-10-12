import { BadRequestException } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getWalletCore } from './coin-metadata.js';

export function assertEvmExternalAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || BigInt(address) < 65536n)
    throw new BadRequestException(
      'Recipient must be an external wallet, not a reserved/precompile address',
    );
}

/** Solana wallet owners are on-curve; associated token accounts and program-derived owners are not EOAs. */
export async function assertSolanaExternalAddress(address: string): Promise<void> {
  const core = await getWalletCore();
  try {
    const raw = Buffer.from(core.Base58.decodeNoCheck(address));
    if (raw.length !== 32 || core.Base58.encodeNoCheck(raw) !== address)
      throw new Error('Invalid key');
    assertSolanaExternalKey(raw);
  } catch {
    throw new BadRequestException('Solana recipient must be an on-curve external wallet owner');
  }
}

export function assertSolanaExternalKey(raw: Uint8Array): void {
  try {
    const point = ed25519.Point.fromBytes(raw);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Invalid external signer');
  } catch {
    throw new BadRequestException('Solana recipient must be an on-curve external wallet owner');
  }
}
