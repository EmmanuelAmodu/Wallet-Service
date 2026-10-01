import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SignerModule } from './signer.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(SignerModule, {
    logger: ['warn', 'error'],
  });
  app.enableShutdownHooks();
}
bootstrap().catch(() => {
  console.error('Signer startup failed; check Redis and seed configuration');
  process.exitCode = 1;
});
