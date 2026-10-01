import { Module } from '@nestjs/common';
import { MessagingModule } from '../../../packages/queue/src/module';
import { required } from '../../../packages/shared/src/http';
import { SigningCore } from './core';
import { SignerWorker } from './worker';

@Module({
  imports: [MessagingModule.register()],
  providers: [
    SignerWorker,
    {
      provide: SigningCore,
      useFactory: () =>
        SigningCore.fromFile(
          required('SIGNER_SEED_FILE'),
          required('SIGNER_SEED_ID'),
          required('ETH_CHAIN_ID'),
        ),
    },
  ],
})
export class SignerModule {}
