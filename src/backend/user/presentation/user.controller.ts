import type { AuthResponse } from '../../../shared/contracts/auth.contract.ts';
import type { Logger } from '../../shared/domain/logger.ts';
import type { Result } from '../../shared/domain/result.ts';
import type { CredentialsInput } from '../application/user.credentials.ts';

import {
  AppError,
  BadRequestError,
  InternalServerError,
  UnsupportedMediaTypeError,
} from '../../shared/domain/app.error.ts';
import { errorResponse } from '../../shared/http/http.error-response.ts';

export type AuthController = {
  readonly signIn: (request: Request) => Promise<Response>;
  readonly signUp: (request: Request) => Promise<Response>;
};

export type AuthUseCase = {
  execute: (input: CredentialsInput) => Promise<Result<AuthResponse, AppError>>;
};

/**
 * Media type without parameters, lower-cased: `Application/JSON; charset=utf-8` ->
 * `application/json`.
 */
function mediaTypeOf(request: Request): string {
  return (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Only `application/json` is accepted: `text/plain`, form and multipart bodies are CORS simple
 * requests that a foreign page can send without a preflight.
 */
async function readCredentials(request: Request): Promise<CredentialsInput> {
  if (mediaTypeOf(request) !== 'application/json') {
    throw new UnsupportedMediaTypeError('Content-Type must be application/json');
  }
  const body: unknown = await request.json().catch(() => {
    throw new BadRequestError('Request body must be valid JSON');
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object');
  }
  return body;
}

/**
 * Two failure paths reach the client in the same shape: expected failures come back as a `Result`,
 * unexpected ones are thrown. Thrown `AppError`s keep their status; anything else is a 500.
 */
type HandleOptions = {
  readonly logger: Logger;
  readonly request: Request;
  readonly successStatus: number;
  readonly useCase: AuthUseCase;
};

export function createAuthController(
  useCases: { readonly signIn: AuthUseCase; readonly signUp: AuthUseCase },
  logger: Logger,
): AuthController {
  return {
    signIn: async (request) =>
      handle({ logger, request, successStatus: 200, useCase: useCases.signIn }),
    signUp: async (request) =>
      handle({ logger, request, successStatus: 201, useCase: useCases.signUp }),
  };
}

async function handle({
  logger,
  request,
  successStatus,
  useCase,
}: HandleOptions): Promise<Response> {
  try {
    const result = await useCase.execute(await readCredentials(request));
    if (!result.ok) {
      return errorResponse(request, result.error);
    }
    return Response.json(result.value, { status: successStatus });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(request, error);
    }
    logger.error(error);
    return errorResponse(request, new InternalServerError());
  }
}
