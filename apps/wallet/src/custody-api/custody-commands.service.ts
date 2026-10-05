import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Message, QUEUES } from '../../../../packages/queue/src/messages.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { queueConfig, QueueConfig } from '../../../../packages/queue/src/queue.config.js';
import { exchangeApiConfig, ExchangeApiSettings } from '../config/exchange-api.config.js';
import { CustodyService } from '../custody/custody.service.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CustodyCommandsService {
  constructor(
    private readonly db: WalletPrismaService,
    private readonly custody: CustodyService,
    @Inject(exchangeApiConfig.KEY) private readonly settings: ExchangeApiSettings,
    @Inject(queueConfig.KEY) private readonly queue: Pick<QueueConfig, 'resetEpoch'>,
  ) {}

  private domain() {
    if (!this.settings.domainId) throw new ServiceUnavailableException('Custody is not configured');
    return this.settings.domainId;
  }

  private async submit(
    message: Extract<Message, { type: 'custody.bootstrap' | 'custody.management.create' }>,
  ) {
    await this.db.$transaction((db) =>
      enqueue(db, QUEUES.wallet, message, `custody-${message.commandId}`),
    );
    return { commandId: message.commandId, domainId: message.domainId, state: 'queued' };
  }

  bootstrap() {
    return this.submit({
      type: 'custody.bootstrap',
      commandId: randomUUID(),
      domainId: this.domain(),
    });
  }

  management(input: {
    chain: 'ethereum' | 'bitcoin' | 'solana';
    network: string;
    account: number;
  }) {
    this.custody.validateNetwork(input.chain, input.network);
    return this.submit({
      type: 'custody.management.create',
      commandId: randomUUID(),
      domainId: this.domain(),
      ...input,
    });
  }

  async status() {
    const domainId = this.domain();
    const domain = await this.db.custodyDomain.findUnique({ where: { id: domainId } });
    const wallets = await this.db.wallet.findMany({
      where: {
        custody_domain_id: domainId,
        reset_epoch: this.queue.resetEpoch,
        custody_role: { in: ['hot', 'management'] },
      },
      orderBy: [{ chain: 'asc' }, { account: 'asc' }],
      select: {
        id: true,
        chain: true,
        network: true,
        custody_role: true,
        account: true,
        path: true,
        address: true,
        status: true,
        management_purpose: true,
        active: true,
        registry_revision: true,
        published_at: true,
        last_error: true,
      },
    });
    return {
      domainId,
      resetEpoch: this.queue.resetEpoch,
      state: domain?.status ?? 'not_bootstrapped',
      wallets,
    };
  }
}
