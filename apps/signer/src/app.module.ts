import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config.js';
import { signerConfig } from './config/signer.config.js';
import { SigningModule } from './signing/signing.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, load: [queueConfig, signerConfig] }),
    SigningModule,
  ],
})
export class AppModule {}
