import type { ErrorResponse } from '../../../shared/contracts/error.contract.ts';

import { type AppError, TooManyRequestsError } from '../domain/app.error.ts';
import { SECURITY_HEADERS } from './security-headers.ts';

export const CORRELATION_HEADER = 'x-correlation-id';

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Reuses the caller's correlation id when it sends one, otherwise mints a new one. */
export function correlationIdOf(request: Request): string {
  return request.headers.get(CORRELATION_HEADER) ?? crypto.randomUUID();
}

/**
 * Renders an `AppError`; `errors` only appears when there are field errors, and `Retry-After` only
 * on a 429.
 */
export function errorResponse(request: Request, error: AppError, now = new Date()): Response {
  const correlationId = correlationIdOf(request);
  const body: ErrorResponse = {
    correlationId,
    error: STATUS_TEXT[error.statusCode] ?? 'Error',
    ...(error.errors.length > 0 && { errors: error.errors }),
    message: error.message,
    path: new URL(request.url).pathname,
    statusCode: error.statusCode,
    timestamp: now.toISOString(),
  };
  return Response.json(body, {
    headers: {
      ...SECURITY_HEADERS,
      [CORRELATION_HEADER]: correlationId,
      ...(error instanceof TooManyRequestsError && {
        'retry-after': String(error.retryAfterSeconds),
      }),
    },
    status: error.statusCode,
  });
}
