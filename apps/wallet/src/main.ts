import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { integerSetting } from '../../../packages/shared/src/config';
import { auth, required, SafeErrors, token } from '../../../packages/shared/src/http';
import { WalletModule } from './wallet.module';

async function bootstrap() {
  const port = integerSetting('WALLET_PORT', 3000, 1, 65535);
  const keys = z
    .record(z.string().min(1), z.string().min(32))
    .parse(JSON.parse(required('WALLET_API_KEYS')));
  if (Object.values(keys).includes(token(required('QUEUE_AUTH_KEY'))))
    throw new Error('Use distinct tenant and queue credentials');
  const app = await NestFactory.create(WalletModule, { logger: ['error', 'warn'] });
  app.use(auth(keys));
  app.useGlobalFilters(new SafeErrors());
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.listen(port, process.env.WALLET_HOST ?? '127.0.0.1');
}
bootstrap().catch(() => {
  console.error('Wallet startup failed; check database, Redis, and configuration');
  process.exitCode = 1;
});
