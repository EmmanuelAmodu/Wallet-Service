import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { Chain } from '../../../../packages/shared/src/contracts.js';
import { canonical, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import { getWalletCore, walletCoreMetadata } from '../../../../packages/chain/src/coin-metadata.js';

import { walletConfig, WalletConfig } from '../config/wallet.config.js';

@Injectable()
export class WalletsService {
  constructor(
    @Inject(WalletPrismaService) readonly db: PrismaClient,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
  ) {}

  async createWallet(chain: Chain, externalId: string) {
    const network = networkFor(chain, this.config);
    const core = await getWalletCore();
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['wallet', chain, network, externalId]));
      const existing = await db.wallet.findFirst({
        where: { external_id: externalId, chain, network },
      });
      if (existing) return existing;
      const [sequence] = await db.$queryRaw<
        { account: bigint }[]
      >`SELECT nextval('wallets_account_seq') AS account`;
      const account = Number(sequence.account),
        id = randomUUID();
      const path = walletCoreMetadata(core, chain, account).path;
      const wallet = await db.wallet.create({
        data: {
          id,
          external_id: externalId,
          chain,
          network,
          seed_id: this.config.seedId,
          account,
          path,
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

  async getWallet(id: string) {
    const wallet = await this.db.wallet.findFirst({ where: { id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }
}
