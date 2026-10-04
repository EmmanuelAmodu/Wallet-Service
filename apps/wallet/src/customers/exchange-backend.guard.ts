import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { matches } from '../../../../packages/shared/src/security/tokens.js';
import { exchangeApiConfig, ExchangeApiSettings } from '../config/exchange-api.config.js';

export const EXCHANGE_BACKEND_ROUTE = 'exchangeBackendRoute';
export const ExchangeBackendRoute = () => SetMetadata(EXCHANGE_BACKEND_ROUTE, true);

@Injectable()
export class ExchangeBackendGuard implements CanActivate {
  constructor(@Inject(exchangeApiConfig.KEY) private readonly settings: ExchangeApiSettings) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.settings.apiKey || !this.settings.domainId)
      throw new ServiceUnavailableException('Exchange backend API is not configured');
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const header = request.headers.authorization;
    const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!matches(this.settings.apiKey, value)) throw new UnauthorizedException('Unauthorized');
    return true;
  }
}
