import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../../../packages/shared/src/http/zod-validation.pipe.js';
import { registerUserSchema, RegisterUserDto } from './dto/register-user.dto.js';
import { RegistrationThrottleGuard } from './registration-throttle.guard.js';
import { UsersService } from './users.service.js';

@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('register')
  @UseGuards(RegistrationThrottleGuard)
  register(@Body(new ZodValidationPipe(registerUserSchema)) body: RegisterUserDto) {
    return this.users.register(body);
  }
}
