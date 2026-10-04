import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { matches } from '../../../../packages/shared/src/security/tokens.js';
import { walletConfig, WalletSettings } from '../config/wallet.config.js';
import { TenantRequest } from './tenant.decorator.js';
import { Reflector } from '@nestjs/core';
import { EXCHANGE_BACKEND_ROUTE } from '../customers/exchange-backend.guard.js';

@Injectable()
export class TenantAuthGuard implements CanActivate {
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
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = Object.entries(this.config.apiKeys).find(([, key]) => matches(key, bearer));
    if (!entry) throw new UnauthorizedException('Unauthorized');
    request.tenant = entry[0];
    return true;
  }
}
