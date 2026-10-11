import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../apps/signer/src/app.module.js';
import { SigningCore } from '../../apps/signer/src/signing/signing.core.js';
import { SigningService } from '../../apps/signer/src/signing/signing.service.js';

// Test-only legacy transport fixture. Production AppModule always supplies the
// custody policy and refuses HMAC-only signing, even with sweeps disabled.
async function bootstrap() {
  const app = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SigningService)
    .useFactory({ factory: (core: SigningCore) => new SigningService(core), inject: [SigningCore] })
    .compile();
  app.enableShutdownHooks();
  await app.init();
}

bootstrap().catch(() => {
  console.error('Legacy transport test worker startup failed');
  process.exitCode = 1;
});
