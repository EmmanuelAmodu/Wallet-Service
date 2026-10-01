import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
export type TenantRequest = Request & { tenant: string };
export const Tenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<TenantRequest>().tenant,
);
