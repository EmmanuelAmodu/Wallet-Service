import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module';
import { signerConfig } from '../config/signer.config';
import { SignerProcessor } from './signer.processor';
import { SigningService } from './signing.service';
import { SigningCore } from './signing.core';
@Module({
  imports: [MessagingModule],
  providers: [
    SignerProcessor,
    SigningService,
    {
      provide: SigningCore,
      inject: [signerConfig.KEY],
      useFactory: (config: ConfigType<typeof signerConfig>) =>
        SigningCore.fromFile(config.seedFile, config.seedId, config.ethereumChainId),
    },
  ],
})
export class SigningModule {}
