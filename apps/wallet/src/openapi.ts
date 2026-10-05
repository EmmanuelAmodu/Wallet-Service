import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Exchange Wallet API')
    .setDescription('Authenticated customer wallet, deposit, and balance endpoints.')
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT issued by User service' },
      'customerBearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => path.startsWith('/v1/')),
  );
  SwaggerModule.setup('docs', app, document);
}
