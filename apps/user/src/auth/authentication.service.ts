import {
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccessTokenIssuer } from '../../../../packages/shared/src/security/access-tokens.js';
import { MessageAuth } from '../../../../packages/queue/src/messages.js';
import { userAuthConfig, UserAuthSettings } from '../config/user-auth.config.js';
import { UserPrismaService } from '../prisma/prisma.service.js';
import { PasswordHasher } from '../users/password-hasher.service.js';
import { LoginDto, loginSchema } from './login.dto.js';

// A missing account still performs the same bounded scrypt work as an incorrect password.
const DUMMY_HASH = `scrypt$131072$8$1$${'0'.repeat(64)}$${'0'.repeat(128)}`;

@Injectable()
export class AuthenticationService implements OnModuleInit {
  private readonly issuer?: AccessTokenIssuer;

  constructor(
    private readonly db: UserPrismaService,
    private readonly passwords: PasswordHasher,
    @Inject(userAuthConfig.KEY) settings: UserAuthSettings,
    @Inject(MessageAuth) auth: MessageAuth,
  ) {
    if (settings.privateKey)
      this.issuer = new AccessTokenIssuer(
        settings.privateKey,
        { issuer: settings.issuer, audience: settings.audience, resetEpoch: auth.resetEpoch },
        settings.lifetimeSeconds,
      );
  }

  async onModuleInit() {
    await this.issuer?.ready();
  }

  async login(input: LoginDto) {
    const body = loginSchema.parse(input);
    if (!this.issuer) throw new ServiceUnavailableException('Login is not configured');
    const user = await this.db.user.findUnique({
      where: { email: body.email },
      select: { id: true, password_hash: true },
    });
    const valid = await this.passwords.verify(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');
    return this.issuer.issue(user.id);
  }
}
