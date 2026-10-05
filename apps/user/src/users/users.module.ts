import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { OutboxModule } from '../../../../packages/queue/src/outbox.module.js';
import { UserPrismaModule } from '../prisma/prisma.module.js';
import { UserPrismaService } from '../prisma/prisma.service.js';
import { PasswordHasher } from './password-hasher.service.js';
import { RegistrationThrottleGuard } from './registration-throttle.guard.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    UserPrismaModule,
    MessagingModule,
    OutboxModule.register(UserPrismaModule, UserPrismaService),
  ],
  controllers: [UsersController],
  providers: [UsersService, PasswordHasher, RegistrationThrottleGuard],
  exports: [PasswordHasher],
})
export class UsersModule {}
