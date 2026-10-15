import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { MessagingModule } from '../../../../packages/queue/src/messaging.module.js';
import { signerConfig } from '../config/signer.config.js';
import { SignerProcessor } from './signer.processor.js';
import { SigningService } from './signing.service.js';
import { SigningCore } from './signing.core.js';
import { TokenSigningPolicy } from './token-signing.policy.js';
import { CustodySigningPolicy } from './custody-signing.policy.js';
import { queueConfig } from '../../../../packages/queue/src/queue.config.js';
@Module({
  imports: [MessagingModule],
  providers: [
    SignerProcessor,
    SigningService,
    {
      provide: TokenSigningPolicy,
      inject: [signerConfig.KEY, queueConfig.KEY, SigningCore],
      useFactory: (
        config: ConfigType<typeof signerConfig>,
        queue: ConfigType<typeof queueConfig>,
        core: SigningCore,
      ) =>
        new TokenSigningPolicy(
          {
            enabled: config.tokenSigningEnabled,
            domainId: config.domainId,
            resetEpoch: queue.resetEpoch,
            authorityPublicKey: config.executionAuthorityPublicKey,
          },
          core,
        ),
    },
    {
      provide: CustodySigningPolicy,
      inject: [signerConfig.KEY, queueConfig.KEY, SigningCore],
      useFactory: (
        config: ConfigType<typeof signerConfig>,
        queue: ConfigType<typeof queueConfig>,
        core: SigningCore,
      ) =>
        new CustodySigningPolicy(
          {
            enabled:
              config.nativeSweepsEnabled ||
              config.nativeWithdrawalsEnabled ||
              config.tokenSigningEnabled,
            sweepsEnabled: config.nativeSweepsEnabled,
            withdrawalsEnabled: config.nativeWithdrawalsEnabled,
            bitcoinBatchesEnabled: config.bitcoinBatchesEnabled,
            fundingEnabled: config.tokenSigningEnabled,
            domainId: config.domainId,
            resetEpoch: queue.resetEpoch,
            authorityPublicKey: config.executionAuthorityPublicKey,
            attestationPrivateKey: config.executionSignerPrivateKey,
          },
          core,
        ),
    },
    {
      provide: SigningCore,
      inject: [signerConfig.KEY],
      useFactory: (config: ConfigType<typeof signerConfig>) =>
        SigningCore.fromFile(
          config.seedFile,
          config.seedId,
          config.ethereumChainId,
          config.ethereumChainIds,
          { domainId: config.domainId, chainNetworks: config.chainNetworks },
        ),
    },
  ],
})
export class SigningModule {}
