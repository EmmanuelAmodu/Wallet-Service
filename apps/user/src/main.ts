import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UserErrorsFilter } from './users/user-errors.filter.js';
import { userConfig } from './config/user.config.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['warn', 'error'],
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '8kb' });
  app.enableShutdownHooks();
  app.useGlobalFilters(new UserErrorsFilter());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  const config = app.get<ConfigType<typeof userConfig>>(userConfig.KEY);
  await app.listen(config.port, config.host);
}

bootstrap().catch(() => {
  console.error('User service startup failed; check database and queue configuration');
  process.exitCode = 1;
});
