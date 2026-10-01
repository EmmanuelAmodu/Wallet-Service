import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import type { Response } from 'express';
@Catch()
export class SafeErrorsFilter implements ExceptionFilter {
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
