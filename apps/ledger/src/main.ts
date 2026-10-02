import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import { ledgerConfig } from './config/ledger.config.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.enableShutdownHooks();
  const config = app.get<ConfigType<typeof ledgerConfig>>(ledgerConfig.KEY);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.listen(config.port, config.host);
}

bootstrap().catch(() => {
  console.error('Ledger service startup failed; check database and queue configuration');
  process.exitCode = 1;
});
