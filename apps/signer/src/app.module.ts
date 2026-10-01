import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../../../packages/queue/src/queue.config';
import { signerConfig } from './config/signer.config';
import { SigningModule } from './signing/signing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, load: [queueConfig, signerConfig] }),
    SigningModule,
  ],
})
export class AppModule {}
