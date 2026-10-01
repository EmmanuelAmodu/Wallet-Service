import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Message, MessageAuth, messageSchema, QUEUES } from './messages';
import { queueConfig, QueueConfig } from './queue.config';

export const OUTBOX_DATABASE = Symbol('OUTBOX_DATABASE');
type OutboxRow = { id: string; queue: string; payload: unknown };
type OutboxTransaction = {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  outbox: {
    upsert(args: {
      where: { dedupe_key: string };
      update: Record<string, never>;
      create: {
        id: string;
        queue: string;
        payload: Prisma.InputJsonValue;
        dedupe_key: string;
        available_at: Date;
      };
    }): Promise<OutboxRow>;
    findUniqueOrThrow(args: { where: { id: string } }): Promise<OutboxRow>;
    update(args: { where: { id: string }; data: { published_at: Date } }): Promise<unknown>;
  };
};
export interface OutboxDatabase {
  $transaction<T>(fn: (db: OutboxTransaction) => Promise<T>): Promise<T>;
}
export async function enqueue(
  db: Pick<OutboxTransaction, 'outbox'>,
  queue: string,
  payload: Message,
  dedupeKey: string,
  delayMs = 0,
) {
  return db.outbox.upsert({
    where: { dedupe_key: dedupeKey },
    update: {},
    create: {
      id: randomUUID(),
      queue,
      payload: payload as Prisma.InputJsonValue,
      dedupe_key: dedupeKey,
      available_at: new Date(Date.now() + delayMs),
    },
  });
}
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    @Inject(OUTBOX_DATABASE) private readonly db: OutboxDatabase,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
    @InjectQueue(QUEUES.wallet) private readonly wallet: Queue,
    @InjectQueue(QUEUES.signer) private readonly signer: Queue,
    @InjectQueue(QUEUES.broadcast) private readonly broadcast: Queue,
    @Inject(queueConfig.KEY) private readonly config: Pick<QueueConfig, 'outboxIntervalMs'>,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => this.tick(), this.config.outboxIntervalMs);
    this.tick();
  }
  private tick() {
    if (!this.running)
      this.running = this.flush()
        .catch(() => {
          this.logger.warn('Outbox delivery failed; unpublished actions will be retried');
        })
        .finally(() => {
          this.running = undefined;
        });
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async flush() {
    for (let count = 0; count < 50; count++) {
      const found = await this.db.$transaction(async (db) => {
        const rows = await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM outbox WHERE published_at IS NULL AND available_at <= now() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!rows[0]) return false;
        const row = await db.outbox.findUniqueOrThrow({ where: { id: rows[0].id } });
        const queue = {
          [QUEUES.wallet]: this.wallet,
          [QUEUES.signer]: this.signer,
          [QUEUES.broadcast]: this.broadcast,
        }[row.queue];
        if (!queue) throw new Error('Unknown outbox queue');
        const payload = messageSchema.parse(row.payload);
        let timer: NodeJS.Timeout | undefined;
        try {
          // A late Redis acknowledgement is safe: job IDs and state guards absorb duplicates.
          await Promise.race([
            queue.add(payload.type, this.auth.seal(payload, row.id), { jobId: row.id }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Queue timeout')), 2000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await db.outbox.update({ where: { id: row.id }, data: { published_at: new Date() } });
        return true;
      });
      if (!found) return;
    }
  }
}
