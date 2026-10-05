import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { userConfig, UserConfig } from '../config/user.config.js';

type Window = { startedAt: number; count: number };
const MAX_TRACKED_IPS = 10000;

@Injectable()
export class RegistrationThrottleGuard implements CanActivate {
  private global: Window = { startedAt: 0, count: 0 };
  private readonly clients = new Map<string, Window>();

  constructor(
    @Inject(userConfig.KEY)
    private readonly config: Pick<
      UserConfig,
      'registrationWindowMs' | 'registrationIpLimit' | 'registrationGlobalLimit'
    >,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const now = Date.now();
    if (now - this.global.startedAt >= this.config.registrationWindowMs) {
      this.global = { startedAt: now, count: 0 };
      for (const [ip, window] of this.clients)
        if (now - window.startedAt >= this.config.registrationWindowMs) this.clients.delete(ip);
    }
    // The default server does not trust forwarded headers; only the direct socket/client address is used.
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    let window = this.clients.get(ip);
    if (window && now - window.startedAt >= this.config.registrationWindowMs) {
      this.clients.delete(ip);
      window = undefined;
    }
    if (!window && this.clients.size < MAX_TRACKED_IPS) {
      window = { startedAt: now, count: 0 };
      this.clients.set(ip, window);
    }
    if (
      !window ||
      this.global.count >= this.config.registrationGlobalLimit ||
      window.count >= this.config.registrationIpLimit
    ) {
      response.setHeader('Retry-After', Math.ceil(this.config.registrationWindowMs / 1000));
      throw new HttpException(
        'Too many authentication attempts; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.global.count++;
    window.count++;
    return true;
  }
}
