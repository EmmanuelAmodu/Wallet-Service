import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { matches } from '../../../../packages/shared/src/security/tokens.js';
import { walletConfig, WalletSettings } from '../config/wallet.config.js';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { EXCHANGE_BACKEND_ROUTE } from '../customers/exchange-backend.guard.js';
import { CUSTOMER_AUTHENTICATED_ROUTE } from './customer-auth.guard.js';

@Injectable()
export class WalletAuthGuard implements CanActivate {
  constructor(
    @Inject(walletConfig.KEY) private readonly config: WalletSettings,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(EXCHANGE_BACKEND_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (
      this.reflector.getAllAndOverride<boolean>(CUSTOMER_AUTHENTICATED_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!matches(this.config.apiKey, bearer)) throw new UnauthorizedException('Unauthorized');
    return true;
  }
}
