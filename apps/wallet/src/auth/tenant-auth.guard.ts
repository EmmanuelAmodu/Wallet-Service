import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { matches } from '../../../../packages/shared/src/security/tokens';
import { walletConfig, WalletSettings } from '../config/wallet.config';
import { TenantRequest } from './tenant.decorator';

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(@Inject(walletConfig.KEY) private readonly config: WalletSettings) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = Object.entries(this.config.apiKeys).find(([, key]) => matches(key, bearer));
    if (!entry) throw new UnauthorizedException('Unauthorized');
    request.tenant = entry[0];
    return true;
  }
}
