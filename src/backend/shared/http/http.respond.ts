import type { Logger } from '../domain/logger.ts';
import type { Result } from '../domain/result.ts';

import { AppError, InternalServerError } from '../domain/app.error.ts';
import { errorResponse } from './http.error-response.ts';
import { SECURITY_HEADERS } from './security-headers.ts';

/**
 * Runs a handler so both failure paths reach the client in the same shape: thrown `AppError`s keep
 * their status, and anything else is logged and hidden behind a 500.
 */
export async function respond(
  request: Request,
  logger: Logger,
  run: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(request, error);
    }
    logger.error(error);
    return errorResponse(request, new InternalServerError());
  }
}

/** The value as JSON with `status`, or the expected failure rendered by `errorResponse`. */
export function resultResponse<T>(
  request: Request,
  result: Result<T, AppError>,
  status = 200,
): Response {
  return result.ok
    ? Response.json(result.value, { headers: SECURITY_HEADERS, status })
    : errorResponse(request, result.error);
}
