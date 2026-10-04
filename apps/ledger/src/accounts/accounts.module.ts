import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';

@Module({ providers: [AccountsService], exports: [AccountsService] })
export class AccountsModule {}
