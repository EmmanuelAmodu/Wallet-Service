import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WalletConfig } from '../../apps/wallet/src/config/wallet.config.js';
import { migrate } from '../../scripts/migrate.js';

export const devnet = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const testMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export function custodySettings(domainId: string): WalletConfig {
  return {
    domainId,
    seedId: `seed-${domainId}`,
    ethereumChainId: '11155111',
    solanaGenesisHash: devnet,
    chainNetworks: { bitcoin: { network: 'regtest', rpcNetwork: 'regtest' } },
  };
}

// Published custody identities deliberately cannot be deleted. Tests own fresh
// sibling databases, rather than disabling production invariants for cleanup.
export async function isolatedDatabase(
  source: string,
  application: 'wallet' | 'ledger' | 'sweep' | 'broadcast' = 'wallet',
) {
  const name = `waas_${application}_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: source });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(source);
  url.pathname = `/${name}`;
  const drop = async () => {
    const db = new Client({ connectionString: source });
    await db.connect();
    try {
      await db.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await db.end();
    }
  };
  try {
    await migrate(url.toString(), application);
  } catch (error) {
    await drop();
    throw error;
  }
  return { url: url.toString(), drop };
}
