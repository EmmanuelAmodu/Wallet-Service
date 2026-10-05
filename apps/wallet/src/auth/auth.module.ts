import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { WalletAuthGuard } from './wallet-auth.guard.js';
@Module({ providers: [{ provide: APP_GUARD, useClass: WalletAuthGuard }] })
export class AuthModule {}
