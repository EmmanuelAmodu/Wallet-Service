import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { BroadcastModule } from './broadcast.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(BroadcastModule, {
    logger: ['warn', 'error'],
  });
  app.enableShutdownHooks();
}
bootstrap().catch(() => {
  console.error('Broadcast startup failed; check database, Redis, and RPC configuration');
  process.exitCode = 1;
});
