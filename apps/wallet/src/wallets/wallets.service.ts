import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { postgresErrorCode } from '../../../../packages/database/src/postgres-error.js';
import { Chain } from '../../../../packages/shared/src/contracts.js';
import {
  canonical,
  derivationRequestDigest,
  QUEUES,
} from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { networkFor } from '../../../../packages/chain/src/config.js';
import { coreDerivationPath } from '../../../../packages/chain/src/coin-metadata.js';
import { queueConfig, QueueConfig } from '../../../../packages/queue/src/queue.config.js';

import { walletConfig, WalletConfig } from '../config/wallet.config.js';

@Injectable()
export class WalletsService {
  constructor(
    @Inject(WalletPrismaService) readonly db: PrismaClient,
    @Inject(walletConfig.KEY) private readonly config: WalletConfig,
    @Optional() @Inject(queueConfig.KEY) private readonly queue?: Pick<QueueConfig, 'resetEpoch'>,
  ) {}

  async createWallet(chain: Chain, externalId: string) {
    const network = networkFor(chain, this.config);
    return this.db.$transaction(async (db) => {
      await lock(db, canonical(['wallet', chain, network, externalId]));
      const existing = await db.wallet.findFirst({
        where: { external_id: externalId, chain, network },
      });
      if (existing) return existing;
      let sequence: { account: bigint };
      try {
        [sequence] = await db.$queryRaw<
          { account: bigint }[]
        >`SELECT nextval('wallets_account_seq') AS account`;
      } catch (error) {
        if (postgresErrorCode(error) === '2200H')
          throw new ConflictException('Customer account allocation is exhausted');
        throw error;
      }
      const account = Number(sequence.account),
        id = randomUUID();
      if (account < 10 || account > 2147483647)
        throw new ConflictException('Customer account allocation is outside its allowed range');
      const path = await coreDerivationPath(chain, account, network);
      const requestId = randomUUID();
      const binding = {
        walletId: id,
        requestId,
        domainId: this.config.domainId ?? 'legacy-internal',
        network,
        path,
        role: 'legacy' as const,
        request: { chain, account, seedId: this.config.seedId },
      };
      const requestDigest = derivationRequestDigest(binding);
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
          reset_epoch: this.queue?.resetEpoch ?? 'test-epoch',
          derivation_request_id: requestId,
          derivation_request_digest: requestDigest,
        },
      });
      await enqueue(
        db,
        QUEUES.signer,
        {
          type: 'wallet.derive',
          ...binding,
          requestDigest,
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
