import { Inject, Injectable } from '@nestjs/common';
import { userConfig, UserConfig } from '../config/user.config.js';
import { RegistrationThrottleGuard } from '../users/registration-throttle.guard.js';

@Injectable()
export class LoginThrottleGuard extends RegistrationThrottleGuard {
  constructor(@Inject(userConfig.KEY) config: UserConfig) {
    super({
      registrationWindowMs: config.loginWindowMs,
      registrationIpLimit: config.loginIpLimit,
      registrationGlobalLimit: config.loginGlobalLimit,
    });
  }
}
