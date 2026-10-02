import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  app.enableShutdownHooks();
}

bootstrap().catch(() => {
  console.error('Signer startup failed; check application configuration and dependencies');
  process.exitCode = 1;
});
