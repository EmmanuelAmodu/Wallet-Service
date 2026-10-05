import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenVerifier } from '../../../../packages/shared/src/security/access-tokens.js';
import { MessageAuth } from '../../../../packages/queue/src/messages.js';
import { customerAuthConfig, CustomerAuthSettings } from '../config/customer-auth.config.js';

export const CUSTOMER_AUTHENTICATED_ROUTE = 'customerAuthenticatedRoute';
export const CustomerAuthenticatedRoute = () => SetMetadata(CUSTOMER_AUTHENTICATED_ROUTE, true);
type AuthenticatedRequest = Request & { userId: string };

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().userId;
  if (!userId) throw new UnauthorizedException('Unauthorized');
  return userId;
});

@Injectable()
export class CustomerAuthGuard implements CanActivate, OnModuleInit {
  private readonly verifier?: AccessTokenVerifier;

  constructor(
    @Inject(customerAuthConfig.KEY) settings: CustomerAuthSettings,
    @Inject(MessageAuth) auth: MessageAuth,
  ) {
    if (settings.publicKey)
      this.verifier = new AccessTokenVerifier(settings.publicKey, {
        issuer: settings.issuer,
        audience: settings.audience,
        resetEpoch: auth.resetEpoch,
      });
  }

  async onModuleInit() {
    await this.verifier?.ready();
  }

  async canActivate(context: ExecutionContext) {
    if (!this.verifier)
      throw new ServiceUnavailableException('Customer authentication is not configured');
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const identity = await this.verifier.verify(bearer);
      request.userId = identity.userId;
      return true;
    } catch {
      throw new UnauthorizedException('Unauthorized');
    }
  }
}
