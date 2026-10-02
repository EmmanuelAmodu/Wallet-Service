import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { signerConfig } from '../config/signer.config.js';
import { SignerProcessor } from './signer.processor.js';
import { SigningService } from './signing.service.js';
import { SigningCore } from './signing.core.js';
@Module({
  imports: [MessagingModule],
  providers: [
    SignerProcessor,
    SigningService,
    {
      provide: SigningCore,
      inject: [signerConfig.KEY],
      useFactory: (config: ConfigType<typeof signerConfig>) =>
        SigningCore.fromFile(
          config.seedFile,
          config.seedId,
          config.ethereumChainId,
          config.ethereumChainIds,
        ),
    },
  ],
})
export class SigningModule {}
