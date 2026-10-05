import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { AuthenticationService } from './authentication.service.js';
import { LoginDto, loginSchema } from './login.dto.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';

@Controller('v1/users')
export class AuthenticationController {
  constructor(private readonly authentication: AuthenticationService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottleGuard)
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    return this.authentication.login(body);
  }
}
