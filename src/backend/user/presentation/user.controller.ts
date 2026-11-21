import type { AuthResponse, PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { Logger } from '../../shared/domain/logger.ts';
import type { Result } from '../../shared/domain/result.ts';
import type { CredentialsInput } from '../application/user.credentials.ts';
import type { AuthSession } from '../application/user.session.ts';
import type { UserId } from '../domain/user.value-objects.ts';

import { AppError, InternalServerError, UnauthorizedError } from '../../shared/domain/app.error.ts';
import {
  clearedSessionCookies,
  sessionCookies,
  withCookies,
} from '../../shared/http/http.cookies.ts';
import { errorResponse } from '../../shared/http/http.error-response.ts';
import { readCappedJsonObject, readQuery } from '../../shared/http/http.json-body.ts';
import { respond, resultResponse } from '../../shared/http/http.respond.ts';
import { SECURITY_HEADERS } from '../../shared/http/security-headers.ts';

export type AuthController = {
  readonly signIn: (request: Request) => Promise<Response>;
  readonly signUp: (request: Request) => Promise<Response>;
};

export type AuthUseCase = {
  execute: (input: CredentialsInput) => Promise<Result<AuthSession, AppError>>;
};

export type LookupUserPort = {
  execute: (rawName: unknown) => Promise<Result<PublicUser, AppError>>;
};

export type RefreshController = {
  /**
   * `POST /api/auth/refresh` with the session cookie or `Authorization: Bearer <jwt>` (the token,
   * unverified, comes from the guard); answers `{ user }` and sets fresh session cookies.
   */
  readonly refresh: (request: Request, token: null | string) => Promise<Response>;
};

export type RefreshPort = {
  execute: (token: string) => Promise<Result<AuthSession, AppError>>;
};

export type SignOutController = {
  /** `POST /api/auth/sign-out`: 204, the session is over, and both session cookies are cleared. */
  readonly signOut: (request: Request, token: null | string) => Promise<Response>;
};

export type SignOutPort = {
  execute: (token: string) => Promise<Result<null, AppError>>;
};

export type UserController = {
  /** `GET /api/users/:name` for a signed-in user; answers `{ id, name }`. */
  readonly lookup: (request: Request, actor: UserId, name: string) => Promise<Response>;
};

/**
 * Only `application/json` is accepted: `text/plain`, form and multipart bodies are CORS simple
 * requests that a foreign page can send without a preflight. The body is capped at 64 KiB like
 * every other JSON route, before anything parses it: these routes are public.
 */
async function readCredentials(request: Request): Promise<CredentialsInput> {
  return readCappedJsonObject(request);
}

/**
 * Two failure paths reach the client in the same shape: expected failures come back as a `Result`,
 * unexpected ones are thrown. Thrown `AppError`s keep their status; anything else is a 500.
 */
type HandleOptions = {
  readonly cookieMaxAgeSeconds: number;
  readonly logger: Logger;
  readonly request: Request;
  readonly successStatus: number;
  readonly useCase: AuthUseCase;
};

/** `{ user }` in the body; the token and its expiry hint only travel as cookies. */
export function createAuthController(
  useCases: { readonly signIn: AuthUseCase; readonly signUp: AuthUseCase },
  logger: Logger,
  /** The cookies' `Max-Age`: the token lifetime. */
  cookieMaxAgeSeconds: number,
): AuthController {
  return {
    signIn: async (request) =>
      handle({
        cookieMaxAgeSeconds,
        logger,
        request,
        successStatus: 200,
        useCase: useCases.signIn,
      }),
    signUp: async (request) =>
      handle({
        cookieMaxAgeSeconds,
        logger,
        request,
        successStatus: 201,
        useCase: useCases.signUp,
      }),
  };
}

function sessionResponse(session: AuthSession, status: number, maxAgeSeconds: number): Response {
  const body: AuthResponse = { user: session.user };
  return withCookies(
    Response.json(body, { headers: SECURITY_HEADERS, status }),
    sessionCookies(session, maxAgeSeconds),
  );
}

/** Token refresh lives beside sign-in and sign-up; it reads no body, only the session token. */
export function createRefreshController(
  useCase: RefreshPort,
  logger: Logger,
  cookieMaxAgeSeconds: number,
): RefreshController {
  return {
    refresh: async (request, token) =>
      respond(request, logger, async () => {
        if (token === null) {
          throw new UnauthorizedError('Missing or invalid token');
        }
        const result = await useCase.execute(token);
        return result.ok
          ? sessionResponse(result.value, 200, cookieMaxAgeSeconds)
          : resultResponse(request, result);
      }),
  };
}

/** Both cookies are cleared whatever happens, so a dead session never lingers in the browser. */
export function createSignOutController(useCase: SignOutPort, logger: Logger): SignOutController {
  return {
    signOut: async (request, token) =>
      withCookies(
        await respond(request, logger, async () => {
          if (token === null) {
            throw new UnauthorizedError('Missing or invalid token');
          }
          const result = await useCase.execute(token);
          return result.ok
            ? new Response(null, { headers: SECURITY_HEADERS, status: 204 })
            : errorResponse(request, result.error);
        }),
        clearedSessionCookies(),
      ),
  };
}

export function createUserController(
  useCases: { readonly lookup: LookupUserPort },
  logger: Logger,
): UserController {
  return {
    lookup: async (request, _actor, name) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        return resultResponse(request, await useCases.lookup.execute(name));
      }),
  };
}

async function handle({
  cookieMaxAgeSeconds,
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
    return sessionResponse(result.value, successStatus, cookieMaxAgeSeconds);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(request, error);
    }
    logger.error(error);
    return errorResponse(request, new InternalServerError());
  }
}
