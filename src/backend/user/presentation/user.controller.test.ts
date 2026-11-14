import { describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../../shared/contracts/error.contract.ts';
import type { Logger } from '../../shared/domain/logger.ts';
import type { AuthSession } from '../application/user.session.ts';

import {
  type AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { UserId } from '../domain/user.value-objects.ts';
import {
  type AuthUseCase,
  createAuthController,
  createRefreshController,
  createSignOutController,
  createUserController,
  type LookupUserPort,
  type RefreshPort,
} from './user.controller.ts';

const session: AuthSession = {
  expiresAt: new Date(1_800_000_000_000),
  token: 'jwt',
  user: { id: 1, name: 'alice' },
};
const MAX_AGE = 3600;
/** The body every successful sign-in, sign-up and refresh answers: no token in it. */
const USER_BODY = { user: { id: 1, name: 'alice' } };
const SESSION_SET_COOKIES = [
  'chat_rsa_session=jwt; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600',
  'chat_rsa_session_hint=1800000000; Secure; SameSite=Strict; Path=/; Max-Age=3600',
];
const CLEARED_SET_COOKIES = [
  'chat_rsa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
  'chat_rsa_session_hint=; Secure; SameSite=Strict; Path=/; Max-Age=0',
];

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
}

/** Use case that settles with the given result. */
function returning(result: Result<AuthSession, AppError>): AuthUseCase {
  return { execute: async () => result };
}

/** Use case that throws the given error. */
function recordingLogger(): Logger & { readonly logged: unknown[] } {
  const logged: unknown[] = [];
  return {
    error: (error) => {
      logged.push(error);
    },
    logged,
  };
}

function throwing(error: Error): AuthUseCase {
  return {
    execute: async () => {
      throw error;
    },
  };
}

const json = JSON.stringify({ name: 'alice', password: 'x' });
const succeeding = returning(ok(session));

describe('auth controller', () => {
  test('sign-up answers 201 and sign-in 200 with {user} only, and set both session cookies', async () => {
    const controller = createAuthController({ signIn: succeeding, signUp: succeeding }, recordingLogger(), MAX_AGE);

    const signUp = await controller.signUp(post('/api/auth/sign-up', json));
    const signIn = await controller.signIn(post('/api/auth/sign-in', json));

    expect(signUp.status).toBe(201);
    expect(await signUp.json()).toEqual(USER_BODY);
    expect(signUp.headers.getSetCookie()).toEqual(SESSION_SET_COOKIES);
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toEqual(USER_BODY);
    expect(signIn.headers.getSetCookie()).toEqual(SESSION_SET_COOKIES);
  });

  test('renders a Result error with field errors', async () => {
    const errors = [{ field: 'name', message: 'Name is required' }];
    const controller = createAuthController(
      { signIn: returning(err(new ValidationError(errors))), signUp: succeeding },
      recordingLogger(),
      MAX_AGE,
    );

    const response = await controller.signIn(post('/api/auth/sign-in', json, { 'x-correlation-id': 'abc' }));
    const body: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('abc');
    expect(body).toEqual({
      correlationId: 'abc',
      error: 'Bad Request',
      errors,
      message: 'Validation failed',
      path: '/api/auth/sign-in',
      statusCode: 400,
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  test('renders a Result error without field errors and omits `errors`', async () => {
    const controller = createAuthController(
      { signIn: returning(err(new UnauthorizedError('Invalid credentials'))), signUp: succeeding },
      recordingLogger(),
      MAX_AGE,
    );

    const response = await controller.signIn(post('/api/auth/sign-in', json));

    expect(await response.json()).toEqual({
      correlationId: expect.any(String),
      error: 'Unauthorized',
      message: 'Invalid credentials',
      path: '/api/auth/sign-in',
      statusCode: 401,
      timestamp: expect.any(String),
    });
  });

  test('renders a thrown AppError with its own status and does not log it', async () => {
    const logger = recordingLogger();
    const controller = createAuthController(
      { signIn: succeeding, signUp: throwing(new ConflictError('User already exists')) },
      logger,
      MAX_AGE,
    );

    const response = await controller.signUp(post('/api/auth/sign-up', json));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'Conflict', message: 'User already exists', statusCode: 409 });
    expect(logger.logged).toHaveLength(0);
  });

  test('hides an unexpected thrown Error behind a 500 and logs it', async () => {
    const failure = new Error('connection refused to 10.0.0.5');
    const logger = recordingLogger();
    const controller = createAuthController({ signIn: throwing(failure), signUp: succeeding }, logger, MAX_AGE);

    const response = await controller.signIn(post('/api/auth/sign-in', json));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
    expect(logger.logged).toEqual([failure]);
  });

  test.each([
    ['{not json', 'Request body must be valid JSON'],
    ['[1, 2]', 'Request body must be a JSON object'],
    ['null', 'Request body must be a JSON object'],
  ])('rejects the body %p with a 400', async (raw, message) => {
    const controller = createAuthController({ signIn: succeeding, signUp: succeeding }, recordingLogger(), MAX_AGE);

    const response = await controller.signUp(post('/api/auth/sign-up', raw));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Bad Request', message, statusCode: 400 });
  });

  test('rejects a non-JSON media type with 415 before calling the use case', async () => {
    let called = false;
    const spy: AuthUseCase = {
      execute: async () => {
        called = true;
        return ok(session);
      },
    };
    const controller = createAuthController({ signIn: spy, signUp: spy }, recordingLogger(), MAX_AGE);

    const response = await controller.signIn(post('/api/auth/sign-in', json, { 'content-type': 'text/plain' }));

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: 'Unsupported Media Type',
      message: 'Content-Type must be application/json',
      statusCode: 415,
    });
    expect(called).toBe(false);
  });
});

function refreshing(result: Result<AuthSession, AppError>, seen: string[] = []): RefreshPort {
  return {
    execute: async (token) => {
      seen.push(token);
      return result;
    },
  };
}

function refreshRequest(): Request {
  return new Request('http://localhost/api/auth/refresh', { method: 'POST' });
}

const ACTOR = UserId.restore(1);

function lookup(result: Result<{ id: number; name: string }, AppError>): LookupUserPort {
  return { execute: async () => result };
}

describe('sign-in next to refresh', () => {
  test('sign-in still reads the JSON body as before, ignores Authorization and answers 200', async () => {
    const inputs: unknown[] = [];
    const signIn: AuthUseCase = {
      execute: async (input) => {
        inputs.push(input);
        return ok(session);
      },
    };
    const controller = createAuthController({ signIn, signUp: succeeding }, recordingLogger(), MAX_AGE);

    const response = await controller.signIn(
      post('/api/auth/sign-in', JSON.stringify({ extra: 1, name: 'alice', password: 'x' }), {
        authorization: 'Bearer stale',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(USER_BODY);
    expect(inputs).toEqual([{ extra: 1, name: 'alice', password: 'x' }]);
  });
});

describe('refresh controller', () => {
  test('answers 200 with {user} for the session token and sets fresh session cookies', async () => {
    const seen: string[] = [];
    const controller = createRefreshController(refreshing(ok(session), seen), recordingLogger(), MAX_AGE);

    const response = await controller.refresh(refreshRequest(), 'old.jwt');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(USER_BODY);
    expect(response.headers.getSetCookie()).toEqual(SESSION_SET_COOKIES);
    expect(seen).toEqual(['old.jwt']);
  });

  test('answers 401 without calling the use case when there is no token', async () => {
    const seen: string[] = [];
    const controller = createRefreshController(refreshing(ok(session), seen), recordingLogger(), MAX_AGE);

    const response = await controller.refresh(refreshRequest(), null);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: 'Missing or invalid token', statusCode: 401 });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('renders the use case refusal as 401 without cookies', async () => {
    const controller = createRefreshController(
      refreshing(err(new UnauthorizedError('Invalid or expired token'))),
      recordingLogger(),
      MAX_AGE,
    );

    const response = await controller.refresh(refreshRequest(), 'expired');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: 'Invalid or expired token' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('user lookup controller', () => {
  test('answers 200 with {id, name}', async () => {
    const controller = createUserController({ lookup: lookup(ok({ id: 2, name: 'bob' })) }, recordingLogger());

    const response = await controller.lookup(new Request('http://localhost/api/users/bob'), ACTOR, 'bob');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 2, name: 'bob' });
  });

  test('answers 404 for an unknown user', async () => {
    const controller = createUserController(
      { lookup: lookup(err(new NotFoundError('User not found'))) },
      recordingLogger(),
    );

    const response = await controller.lookup(new Request('http://localhost/api/users/nobody'), ACTOR, 'nobody');

    expect(response.status).toBe(404);
  });

  test('rejects unknown query parameters with 400', async () => {
    const controller = createUserController({ lookup: lookup(ok({ id: 2, name: 'bob' })) }, recordingLogger());

    const response = await controller.lookup(new Request('http://localhost/api/users/bob?x=1'), ACTOR, 'bob');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ field: 'x', message: 'Unknown field' }] });
  });
});

describe('createSignOutController', () => {
  test('answers 204 with no body once the session is revoked, and clears both cookies', async () => {
    const seen: string[] = [];
    const controller = createSignOutController(
      {
        execute: async (token) => {
          seen.push(token);
          return ok(null);
        },
      },
      recordingLogger(),
    );

    const response = await controller.signOut(refreshRequest(), 'old.jwt');

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toEqual(CLEARED_SET_COOKIES);
    expect(seen).toEqual(['old.jwt']);
  });

  test('answers 401 without a token, and passes on a refusal, clearing both cookies either way', async () => {
    const seen: string[] = [];
    const controller = createSignOutController(
      {
        execute: async (token) => {
          seen.push(token);
          return err(new UnauthorizedError('Invalid or expired token'));
        },
      },
      recordingLogger(),
    );

    const missing = await controller.signOut(refreshRequest(), null);
    const refused = await controller.signOut(refreshRequest(), 'revoked.jwt');

    expect(missing.status).toBe(401);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ message: 'Invalid or expired token', statusCode: 401 });
    expect(missing.headers.getSetCookie()).toEqual(CLEARED_SET_COOKIES);
    expect(refused.headers.getSetCookie()).toEqual(CLEARED_SET_COOKIES);
    expect(seen).toEqual(['revoked.jwt']);
  });
});
