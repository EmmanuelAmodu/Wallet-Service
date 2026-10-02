import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  app.enableShutdownHooks();
}

bootstrap().catch(() => {
  console.error('Activity listener startup failed; check Pub/Sub and queue configuration');
  process.exitCode = 1;
});
