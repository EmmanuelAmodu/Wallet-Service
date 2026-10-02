import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { matches } from '../../../packages/shared/src/security/tokens.js';
import { ledgerConfig, LedgerConfig } from './config/ledger.config.js';

@Injectable()
export class LedgerAuthGuard implements CanActivate {
  constructor(@Inject(ledgerConfig.KEY) private readonly config: LedgerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!matches(this.config.apiKey, bearer)) throw new UnauthorizedException('Unauthorized');
    return true;
  }
}
