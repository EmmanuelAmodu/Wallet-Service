import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { JournalService } from './journal.service.js';

@Module({
  imports: [AccountsModule],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
