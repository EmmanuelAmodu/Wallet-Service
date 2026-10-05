import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { userConfig } from './config/user.config.js';
import { UsersModule } from './users/users.module.js';
import { AuthenticationModule } from './auth/authentication.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, load: [queueConfig, userConfig] }),
    UsersModule,
    AuthenticationModule,
  ],
})
export class AppModule {}
