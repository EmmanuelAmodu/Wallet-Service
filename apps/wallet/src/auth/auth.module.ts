import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TenantAuthGuard } from './tenant-auth.guard';
@Module({ providers: [{ provide: APP_GUARD, useClass: TenantAuthGuard }] })
export class AuthModule {}
