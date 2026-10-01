import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export function token(value: string): string {
  if (value.length < 32) throw new Error('Authentication tokens must be at least 32 characters');
  return value;
}
export function matches(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export type TenantRequest = Request & { tenant: string };
export function auth(keys: Record<string, string>) {
  const entries = Object.entries(keys).map(([tenant, key]) => [tenant, token(key)]);
  if (!entries.length || new Set(entries.map((e) => e[1])).size !== entries.length)
    throw new Error('Provide unique API keys');
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const entry = entries.find(([, key]) => matches(key, bearer));
    if (!entry) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    (req as TenantRequest).tenant = entry[0];
    next();
  };
}
@Catch()
export class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) {
      res.status(400).json({
        message: 'Invalid request',
        fields: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }
    if (error instanceof HttpException) {
      res.status(error.getStatus()).json({ message: error.message });
      return;
    }
    // Never serialize SDK errors, RPC responses, request bodies, or credentials.
    res.status(500).json({ message: 'Internal operation failed' });
  }
}
