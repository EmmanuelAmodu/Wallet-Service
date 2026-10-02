import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { walletConfig, WalletSettings } from './config/wallet.config.js';
import { setupOpenApi } from './openapi.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.enableShutdownHooks();
  const config = app.get<WalletSettings>(walletConfig.KEY);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  setupOpenApi(app);
  await app.listen(config.port, config.host);
}

bootstrap().catch(() => {
  console.error('Wallet startup failed; check application configuration and dependencies');
  process.exitCode = 1;
});
