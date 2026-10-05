import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { exchangeEventSchema } from '../../../../packages/queue/src/exchange-contracts.js';
import { enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { userConfig, UserConfig } from '../config/user.config.js';
import { UserPrismaService } from '../prisma/prisma.service.js';
import { registerUserSchema, RegisterUserDto } from './dto/register-user.dto.js';
import { PasswordHasher } from './password-hasher.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: UserPrismaService,
    private readonly passwords: PasswordHasher,
    @Inject(userConfig.KEY) private readonly config: Pick<UserConfig, 'domainId'>,
    @Inject(MessageAuth) private readonly auth: MessageAuth,
  ) {}

  async register(input: RegisterUserDto) {
    const body = registerUserSchema.parse(input);
    if (await this.db.user.findUnique({ where: { email: body.email }, select: { id: true } }))
      throw new ConflictException('Email is already registered');
    const passwordHash = await this.passwords.hash(body.password);
    const id = randomUUID();
    const createdAt = new Date();
    try {
      await this.db.$transaction(async (db) => {
        await db.user.create({
          data: { id, email: body.email, password_hash: passwordHash, created_at: createdAt },
        });
        const registered = exchangeEventSchema.parse({
          eventId: id,
          schemaVersion: 1,
          resetEpoch: this.auth.resetEpoch,
          occurredAt: createdAt.toISOString(),
          domainId: this.config.domainId,
          correlationId: id,
          causationId: null,
          aggregateId: id,
          revision: 1,
          customerId: id,
          type: 'user.registered.v1',
          data: { userId: id },
        });
        await enqueueFanOut(db, registered, [QUEUES.wallet]);
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002' &&
        (await this.db.user.findUnique({ where: { email: body.email }, select: { id: true } }))
      )
        throw new ConflictException('Email is already registered');
      throw error;
    }
    return {
      userId: id,
      email: body.email,
      createdAt: createdAt.toISOString(),
    };
  }
}
