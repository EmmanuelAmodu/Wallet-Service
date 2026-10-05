import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { SafeErrorsFilter } from '../../../../packages/shared/src/http/safe-errors.filter.js';

@Catch()
export class UserErrorsFilter extends SafeErrorsFilter {
  catch(error: unknown, host: ArgumentsHost) {
    // Nest wraps JSON syntax failures in BadRequestException with the parser's message,
    // which can include raw password fragments. Use a fixed response for those failures.
    if (error instanceof HttpException && error.getStatus() === 400) {
      host.switchToHttp().getResponse<Response>().status(400).json({ message: 'Invalid request' });
      return;
    }
    // Express parsing errors are not Nest HttpExceptions. Preserve the size limit's HTTP status
    // while keeping request bodies and parser diagnostics out of the public response.
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large' &&
      'status' in error &&
      error.status === 413
    ) {
      host
        .switchToHttp()
        .getResponse<Response>()
        .status(413)
        .json({ message: 'Request body is too large' });
      return;
    }
    super.catch(error, host);
  }
}
