import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../prisma/prisma.service';
import { lock } from '../../../../packages/database/src/locks';
import { Chain, derivationPath } from '../../../../packages/shared/src/contracts';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages';
import { enqueue } from '../../../../packages/queue/src/outbox.service';
import { networkFor } from '../../../../packages/chain/src/config';

import { walletConfig, WalletConfig } from '../config/wallet.config';

@Injectable()
export class WalletsService {
  constructor(
    @Inject(WalletPrismaService) readonly db: PrismaClient,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
  ) {}
  async createWallet(tenant: string, chain: Chain, externalId: string) {
    const network = networkFor(chain, this.config);
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['wallet', tenant, chain, network, externalId]));
      const existing = await db.wallet.findFirst({
        where: { tenant_id: tenant, external_id: externalId, chain, network },
      });
      if (existing) return existing;
      const [sequence] = await db.$queryRaw<
        { account: bigint }[]
      >`SELECT nextval('wallet_account_seq') AS account`;
      const account = Number(sequence.account),
        id = randomUUID();
      const wallet = await db.wallet.create({
        data: {
          id,
          tenant_id: tenant,
          external_id: externalId,
          chain,
          network,
          seed_id: this.config.seedId,
          account,
          path: derivationPath(chain, account),
          status: 'deriving',
        },
      });
      await enqueue(
        db,
        QUEUES.signer,
        {
          type: 'wallet.derive',
          walletId: id,
          request: { chain, account, seedId: wallet.seed_id },
        },
        `derive-${id}`,
      );
      return wallet;
    });
  }
  async getWallet(tenant: string, id: string) {
    const wallet = await this.db.wallet.findFirst({ where: { id, tenant_id: tenant } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }
}
