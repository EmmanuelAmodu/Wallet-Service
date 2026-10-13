import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { Optional } from '@nestjs/common';
import { TokenAssetsService, tokenAssetConfigurationSchema } from './token-assets.service.js';
import { CustodyCommandsService } from './custody-commands.service.js';

const bootstrapBody = z.object({}).strict();
const managementBody = z
  .object({
    chain: z.enum(['ethereum', 'bitcoin', 'solana']),
    network: z.string().min(1).max(128),
    account: z.number().int().min(1).max(9).default(1),
  })
  .strict();

// Wallet's global service guard protects these paths; public OpenAPI excludes /internal.
@Controller('internal/custody')
export class CustodyController {
  constructor(
    private readonly commands: CustodyCommandsService,
    @Optional() private readonly assets?: TokenAssetsService,
  ) {}

  @Post('bootstrap')
  @HttpCode(202)
  bootstrap(@Body(new ZodValidationPipe(bootstrapBody)) _body: z.infer<typeof bootstrapBody>) {
    return this.commands.bootstrap();
  }

  @Post('management-wallets')
  @HttpCode(202)
  management(@Body(new ZodValidationPipe(managementBody)) body: z.infer<typeof managementBody>) {
    return this.commands.management(body);
  }

  @Post('assets')
  @HttpCode(202)
  tokenAsset(
    @Body(new ZodValidationPipe(tokenAssetConfigurationSchema))
    body: z.infer<typeof tokenAssetConfigurationSchema>,
  ) {
    if (!this.assets) throw new Error('Token asset configuration unavailable');
    return this.assets.configure(body);
  }

  @Get()
  status() {
    return this.commands.status();
  }
}
