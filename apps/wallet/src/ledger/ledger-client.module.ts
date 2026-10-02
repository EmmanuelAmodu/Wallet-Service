import { Module } from '@nestjs/common';
import { LedgerClient } from './ledger-client.service.js';

@Module({ providers: [LedgerClient], exports: [LedgerClient] })
export class LedgerClientModule {}
