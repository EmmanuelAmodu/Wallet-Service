import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Wallet as a Service API')
    .setDescription('Tenant-authenticated asynchronous wallet and transaction endpoints.')
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Tenant API key' },
      'tenantBearer',
    )
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
