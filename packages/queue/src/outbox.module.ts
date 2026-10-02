import { DynamicModule, Module, Type } from '@nestjs/common';
import { MessagingModule } from './messaging.module.js';
import { OUTBOX_DATABASE, OutboxRelay } from './outbox.service.js';

@Module({})
export class OutboxModule {
  static register(databaseModule: Type<unknown>, databaseProvider: Type<unknown>): DynamicModule {
    return {
      module: OutboxModule,
      imports: [databaseModule, MessagingModule],
      providers: [{ provide: OUTBOX_DATABASE, useExisting: databaseProvider }, OutboxRelay],
    };
  }
}
