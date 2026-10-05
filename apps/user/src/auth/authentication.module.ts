import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { UserPrismaModule } from '../prisma/prisma.module.js';
import { UsersModule } from '../users/users.module.js';
import { userAuthConfig } from '../config/user-auth.config.js';
import { AuthenticationController } from './authentication.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';

@Module({
  imports: [
    ConfigModule.forFeature(userAuthConfig),
    UsersModule,
    UserPrismaModule,
    MessagingModule,
  ],
  controllers: [AuthenticationController],
  providers: [AuthenticationService, LoginThrottleGuard],
})
export class AuthenticationModule {}
