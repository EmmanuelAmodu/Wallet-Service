import { ChainModule } from '../../../../packages/chain/src/chain.module.js';
import { TokenRegistryService } from './token-registry.service.js';
import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { ActivityPrismaModule } from '../prisma/prisma.module.js';
import { ActivityRegistryService } from './registry.service.js';
import { ExchangeProviderModule } from '../provider/provider.module.js';

@Module({
  imports: [ChainModule,ActivityPrismaModule, MessagingModule, ExchangeProviderModule],
  providers: [ActivityRegistryService,TokenRegistryService],
  exports: [ActivityRegistryService,TokenRegistryService],
})
export class ActivityRegistryModule {}
