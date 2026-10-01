import { Module } from '@nestjs/common';
import { networkConfig } from '../../../packages/chain/src/config';
import { Rpc } from '../../../packages/chain/src/rpc';
import { Database } from './database';
import { MessagingModule } from '../../../packages/queue/src/module';
import { OUTBOX_DATABASE, OutboxRelay } from '../../../packages/queue/src/outbox';
import { required } from '../../../packages/shared/src/http';
import { WalletService, WALLET_CONFIG } from './service';
import { WalletWorker } from './worker';
import { WalletController } from './wallet.controller';

@Module({
  imports: [MessagingModule.register()],
  controllers: [WalletController],
  providers: [
    { provide: Database, useFactory: () => new Database() },
    { provide: OUTBOX_DATABASE, useExisting: Database },
    OutboxRelay,
    WalletService,
    WalletWorker,
    {
      provide: WALLET_CONFIG,
      useFactory: () => ({ ...networkConfig(), seedId: required('SIGNER_SEED_ID') }),
    },
    { provide: Rpc, useFactory: () => new Rpc(networkConfig()) },
  ],
})
export class WalletModule {}
