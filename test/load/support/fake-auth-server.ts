// In-memory stand-in for /api/auth/*, with one switchable defect per sabotage. The `honest` mode
// mirrors the real contract, so a probe that fails against a sabotage proves k6 caught that defect.
import { SignJWT } from 'jose';

import { loadConfig } from '../../../src/backend/shared/config/env.config.ts';
import { InMemoryRateLimiter } from '../../../src/backend/shared/rate-limit/rate-limit.in-memory.ts';
import { User } from '../../../src/backend/user/domain/user.entity.ts';
import {
  PasswordHash,
  UserId,
  UserName,
} from '../../../src/backend/user/domain/user.value-objects.ts';
import { JoseTokenIssuer } from '../../../src/backend/user/infrastructure/user.security.jose.ts';
import { STATUS_TEXT } from './error-format.ts';

export const SABOTAGES = [
  'honest',
  'sign-in-401',
  'pool-exists',
  'pool-wrong-password',
  'no-rate-limit',
  'rate-limit-no-retry-after',
  'no-user-id',
  'garbage-token',
  'text-content-type',
  'stripped-errors',
  'unknown-user-accepted',
  'error-bad-timestamp',
  'error-empty-field-errors',
  'error-generic-name',
  'error-no-field-errors',
  'error-no-message',
  'error-no-path',
  'error-no-timestamp',
  'error-non-iso-timestamp',
  'broken-jwt-claims',
  'jwt-expired',
  'jwt-not-json',
  'jwt-wrong-alg',
  'jwt-wrong-name',
  'jwt-wrong-subject',
] as const;
export type FakeAuthServer = {
  readonly baseUrl: string;
  /** Successful sign-ins for names whose sign-up had answered 409, i.e. verified pool reuses. */
  readonly poolReuses: () => number;
  /** Refills the IP buckets, as scripts/load.ts does between runs. */
  readonly resetRateLimits: () => void;
  readonly stop: () => Promise<void>;
  /** Sign-in requests for names that were never registered. */
  readonly unknownSignIns: () => number;
};

export type Sabotage = (typeof SABOTAGES)[number];

/** The fake signs with the real issuer, so its tokens pass `JoseTokenVerifier` with this secret. */
export const FAKE_JWT_SECRET = 'fake-auth-server-secret-at-least-32-bytes';
const PASSWORD = 'correct-Horse-battery-st4ple';
const issuer = new JoseTokenIssuer(FAKE_JWT_SECRET);
/** The server's default IP bucket, which also guards sign-in and sign-up. */
const IP_POLICY = loadConfig({}).rateLimit.ip;
const NAME_PATTERN = /^[\p{L}\p{N}]+$/u;

type ErrorBody = Readonly<Record<string, unknown>>;

export function startFakeAuthServer(sabotage: Sabotage): FakeAuthServer {
  const users = new Map<string, string>();
  let nextId = 1;
  let unknownSignIns = 0;
  let poolReuses = 0;
  let limiter = new InMemoryRateLimiter();
  const conflicted = new Set<string>();

  function error(
    request: Request,
    statusCode: number,
    message: string,
    errors?: unknown[],
    headers: Readonly<Record<string, string>> = {},
  ): Response {
    const full = {
      correlationId: crypto.randomUUID(),
      error: STATUS_TEXT[statusCode] ?? 'Error',
      ...(errors && { errors }),
      message,
      path: new URL(request.url).pathname,
      statusCode,
      timestamp: new Date().toISOString(),
    };
    return Response.json(brokenErrorBody(sabotage, full), { headers, status: statusCode });
  }

  async function session(name: string, status: number): Promise<Response> {
    const userId = nextId;
    nextId += 1;
    const id = sabotage === 'no-user-id' ? undefined : userId;
    const token = await tokenFor(sabotage, userId, name);
    const body = JSON.stringify({ token, user: { id, name } });
    const contentType = sabotage === 'text-content-type' ? 'text/plain' : 'application/json';
    return new Response(body, { headers: { 'content-type': contentType }, status });
  }

  /** The real guard's first step: one token from the client IP's bucket per request. */
  async function rateLimited(request: Request): Promise<null | Response> {
    if (sabotage === 'no-rate-limit') {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called per request, after Bun.serve returned
    const address = server.requestIP(request)?.address ?? 'unknown';
    const outcome = await limiter.take(`ip:${address}`, IP_POLICY);
    if (outcome.allowed) {
      return null;
    }
    const headers =
      sabotage === 'rate-limit-no-retry-after'
        ? {}
        : { 'retry-after': String(outcome.retryAfterSeconds) };
    return error(request, 429, 'Too many requests, slow down', undefined, headers);
  }

  async function credentials(
    request: Request,
  ): Promise<Response | { name: string; password: string }> {
    const limited = await rateLimited(request);
    if (limited) {
      return limited;
    }
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return error(request, 415, 'Content-Type must be application/json');
    }
    const body: unknown = await request.json();
    const fields: Readonly<Record<string, unknown>> =
      typeof body === 'object' && body !== null ? { ...body } : {};
    const name = typeof fields.name === 'string' ? fields.name : '';
    if (!NAME_PATTERN.test(name)) {
      return error(request, 400, 'Validation failed', [
        { field: 'name', message: 'Name must contain only letters and numbers, without spaces' },
      ]);
    }
    return { name, password: typeof fields.password === 'string' ? fields.password : '' };
  }

  const server = Bun.serve({
    fetch: () => new Response('not found', { status: 404 }),
    port: 0,
    routes: {
      '/': new Response('ok'),
      '/api/auth/sign-in': {
        POST: async (request) => {
          const input = await credentials(request);
          if (input instanceof Response) {
            return input;
          }
          const stored = users.get(input.name);
          if (stored === undefined) {
            unknownSignIns += 1;
            return sabotage === 'unknown-user-accepted'
              ? session(input.name, 200)
              : error(request, 401, 'Invalid credentials');
          }
          if (stored !== input.password || sabotage === 'sign-in-401') {
            return error(request, 401, 'Invalid credentials');
          }
          if (conflicted.delete(input.name)) {
            poolReuses += 1;
          }
          return session(input.name, 200);
        },
      },
      '/api/auth/sign-up': {
        POST: async (request) => {
          const input = await credentials(request);
          if (input instanceof Response) {
            return input;
          }
          // `pool-exists`: the sign-in pool was left behind by an aborted earlier run;
          // `pool-wrong-password`: it was, but someone changed those users' password since.
          if (sabotage === 'pool-exists' && /p[0-9]+$/u.test(input.name)) {
            users.set(input.name, PASSWORD);
          }
          if (sabotage === 'pool-wrong-password' && /p[0-9]+$/u.test(input.name)) {
            users.set(input.name, `${PASSWORD}-changed`);
          }
          if (users.has(input.name)) {
            conflicted.add(input.name);
            return error(request, 409, 'User already exists');
          }
          users.set(input.name, input.password);
          return session(input.name, 201);
        },
      },
    },
  });

  return {
    baseUrl: `http://localhost:${server.port}`,
    poolReuses: () => poolReuses,
    resetRateLimits: () => {
      limiter = new InMemoryRateLimiter();
    },
    stop: async () => server.stop(true),
    unknownSignIns: () => unknownSignIns,
  };
}

/** Error-format sabotages; each one breaks a single field, except `stripped-errors`. */
const ERROR_BODY_SABOTAGES: Partial<Record<Sabotage, (full: ErrorBody) => ErrorBody>> = {
  'error-bad-timestamp': (full) => ({ ...full, timestamp: 'yesterday' }),
  'error-empty-field-errors': (full) =>
    full.errors === undefined ? full : { ...full, errors: [] },
  'error-generic-name': (full) => ({ ...full, error: 'Error' }),
  'error-no-field-errors': ({ errors: _errors, ...rest }) => rest,
  'error-no-message': ({ message: _message, ...rest }) => rest,
  'error-no-path': ({ path: _path, ...rest }) => rest,
  'error-no-timestamp': ({ timestamp: _timestamp, ...rest }) => rest,
  'error-non-iso-timestamp': (full) => ({ ...full, timestamp: new Date().toUTCString() }),
  'stripped-errors': (full) => ({ correlationId: full.correlationId, statusCode: full.statusCode }),
};

function brokenErrorBody(sabotage: Sabotage, full: ErrorBody): ErrorBody {
  return ERROR_BODY_SABOTAGES[sabotage]?.(full) ?? full;
}

async function tokenFor(sabotage: Sabotage, id: number, name: string): Promise<string> {
  // Each JWT sabotage breaks exactly one claim, so every claim check is proven on its own.
  const key = new TextEncoder().encode(FAKE_JWT_SECRET);
  if (sabotage === 'broken-jwt-claims') {
    // Correctly signed HS256 with `sub` and `name`, but no `exp`: JoseTokenVerifier refuses it.
    return new SignJWT({ name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(id))
      .sign(key);
  }
  if (sabotage === 'jwt-expired') {
    return new SignJWT({ name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(id))
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
  }
  if (sabotage === 'jwt-wrong-alg') {
    return new SignJWT({ name })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(String(id))
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(FAKE_JWT_SECRET.repeat(2)));
  }
  if (sabotage === 'jwt-wrong-name') {
    return issuer.issue(userOf(id, `${name}x`));
  }
  if (sabotage === 'garbage-token') {
    return 'garbage';
  }
  if (sabotage === 'jwt-not-json') {
    return 'undefined.undefined.undefined';
  }
  return issuer.issue(userOf(sabotage === 'jwt-wrong-subject' ? id + 1000 : id, name));
}

function userOf(id: number, name: string): User {
  return new User(UserId.restore(id), UserName.restore(name), PasswordHash.restore('unused'));
}
