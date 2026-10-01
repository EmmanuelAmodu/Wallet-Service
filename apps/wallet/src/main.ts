import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { walletConfig, WalletSettings } from './config/wallet.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.enableShutdownHooks();
  const config = app.get<WalletSettings>(walletConfig.KEY);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.listen(config.port, config.host);
}
bootstrap().catch(() => {
  console.error('Wallet startup failed; check application configuration and dependencies');
  process.exitCode = 1;
});
