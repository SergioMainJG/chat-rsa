// In-memory stand-in for /api/auth/*, with one switchable defect per sabotage. The `honest` mode
// mirrors the real contract, so a probe that fails against a sabotage proves k6 caught that defect.
import { decodeJwt, SignJWT } from 'jose';

import type { SessionRef, TokenClaims } from '../../../src/backend/user/domain/user.security.ts';

import { loadConfig } from '../../../src/backend/shared/config/env.config.ts';
import { InMemoryRateLimiter } from '../../../src/backend/shared/rate-limit/rate-limit.in-memory.ts';
import { User } from '../../../src/backend/user/domain/user.entity.ts';
import {
  PasswordHash,
  UserId,
  UserName,
} from '../../../src/backend/user/domain/user.value-objects.ts';
import {
  JoseTokenIssuer,
  JoseTokenVerifier,
} from '../../../src/backend/user/infrastructure/user.security.jose.ts';
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
  'token-in-body',
  'session-cookie-not-httponly',
  'hint-cookie-mismatch',
  'jwt-no-sid',
  'jwt-no-sst',
  'session-cookie-not-secure',
  'session-cookie-wrong-max-age',
  'hint-cookie-httponly',
  'hint-cookie-not-secure',
  'hint-cookie-wrong-max-age',
  'cookie-samesite-lax',
  'cookie-path-not-root',
  'sign-out-keeps-cookies',
  'refresh-ignores-revocation',
  'rooms-ignores-revocation',
  'origin-untrusted-allowed',
  'origin-cookie-without-origin-allowed',
  'origin-bearer-without-origin-refused',
] as const;
export type FakeAuthServer = {
  readonly baseUrl: string;
  /** Successful sign-ins for names whose sign-up had answered 409, i.e. verified pool reuses. */
  readonly poolReuses: () => number;
  /**
   * Refills only the IP buckets: the per-account `signin:<name>` buckets keep what earlier runs
   * spent, as when a run's reset skipped them.
   */
  readonly resetIpRateLimits: () => void;
  /** Refills the IP and per-account sign-in buckets, as scripts/load.ts does between runs. */
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
const verifier = new JoseTokenVerifier(FAKE_JWT_SECRET);
const POLICIES = loadConfig({ JWT_SECRET: FAKE_JWT_SECRET }).rateLimit;
/** The server's default IP bucket, which also guards sign-in and sign-up. */
const IP_POLICY = POLICIES.ip;
/** The server's default per-account bucket (`signin:<name>`), spent before the password check. */
const SIGNIN_POLICY = POLICIES.signin;
const TOKEN_LIFETIME_SECONDS = 3600;
const NAME_PATTERN = /^[\p{L}\p{N}]+$/u;
const BEARER = /^Bearer (?<token>\S+)$/iu;

type Credential = { readonly token: string; readonly via: 'bearer' | 'cookie' };
type ErrorBody = Readonly<Record<string, unknown>>;
type StoredUser = { readonly id: number; readonly password: string };

export function startFakeAuthServer(sabotage: Sabotage): FakeAuthServer {
  const users = new Map<string, StoredUser>();
  let nextId = 1;
  let unknownSignIns = 0;
  let poolReuses = 0;
  let limiter = new InMemoryRateLimiter();
  let signInLimiter = new InMemoryRateLimiter();
  const conflicted = new Set<string>();
  /** Session ids ended by a sign-out, as the real `revoked-session:<sid>` keys. */
  const revoked = new Set<string>();

  function allocateId(): number {
    const id = nextId;
    nextId += 1;
    return id;
  }

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

  async function session(
    userId: number,
    name: string,
    status: number,
    existing?: SessionRef,
  ): Promise<Response> {
    const id = sabotage === 'no-user-id' ? undefined : userId;
    const token = await tokenFor(sabotage, userId, name, existing);
    // The real server answers `{ user }` and sets the token in an HttpOnly cookie (S4).
    const body = JSON.stringify(
      sabotage === 'token-in-body' ? { token, user: { id, name } } : { user: { id, name } },
    );
    const contentType = sabotage === 'text-content-type' ? 'text/plain' : 'application/json';
    const response = new Response(body, { headers: { 'content-type': contentType }, status });
    for (const cookie of sessionCookies(sabotage, token)) {
      response.headers.append('set-cookie', cookie);
    }
    return response;
  }

  /** A 429 that says when to retry, unless the sabotage drops `Retry-After`. */
  function tooMany(request: Request, message: string, retryAfterSeconds: number): Response {
    const headers =
      sabotage === 'rate-limit-no-retry-after' ? {} : { 'retry-after': String(retryAfterSeconds) };
    return error(request, 429, message, undefined, headers);
  }

  /** The real guard's first step: one token from the client IP's bucket per request. */
  async function rateLimited(request: Request): Promise<null | Response> {
    if (sabotage === 'no-rate-limit') {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called per request, after Bun.serve returned
    const address = server.requestIP(request)?.address ?? 'unknown';
    const outcome = await limiter.take(`ip:${address}`, IP_POLICY);
    return outcome.allowed
      ? null
      : tooMany(request, 'Too many requests, slow down', outcome.retryAfterSeconds);
  }

  /**
   * The real guard's CSRF step for unsafe methods: a foreign `Origin` is refused, and so is a
   * cookie-authenticated request without one; a bearer request without `Origin` passes.
   */
  function originRefused(request: Request, credential: Credential | null): null | Response {
    const origin = request.headers.get('origin');
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- called per request, after Bun.serve returned
    const allowed = [`http://localhost:${server.port}`, `http://127.0.0.1:${server.port}`];
    let refused: boolean;
    if (origin === null) {
      refused =
        credential?.via === 'cookie'
          ? sabotage !== 'origin-cookie-without-origin-allowed'
          : credential?.via === 'bearer' && sabotage === 'origin-bearer-without-origin-refused';
    } else {
      refused = !allowed.includes(origin) && sabotage !== 'origin-untrusted-allowed';
    }
    return refused ? error(request, 403, 'Origin not allowed') : null;
  }

  /** IP bucket, then the origin check: what the real `session` guard runs before its handler. */
  async function guarded(request: Request): Promise<Response | { credential: Credential | null }> {
    const limited = await rateLimited(request);
    if (limited) {
      return limited;
    }
    const credential = credentialOf(request);
    return originRefused(request, credential) ?? { credential };
  }

  /** The real `RevocationAwareTokenVerifier`, unless the sabotage skips the revocation list. */
  async function claimsOf(token: string, checkRevocation: boolean): Promise<null | TokenClaims> {
    const claims = await verifier.verify(token);
    if (claims === null || (checkRevocation && revoked.has(claims.sessionId))) {
      return null;
    }
    return claims;
  }

  async function credentials(
    request: Request,
  ): Promise<Response | { name: string; password: string }> {
    const limited = await rateLimited(request);
    if (limited) {
      return limited;
    }
    const refused = originRefused(request, null);
    if (refused) {
      return refused;
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

  /** `SignInUseCase`'s throttle: spent before the password check, known and unknown names alike. */
  async function signInThrottled(request: Request, name: string): Promise<null | Response> {
    if (sabotage === 'no-rate-limit') {
      return null;
    }
    const attempt = await signInLimiter.take(`signin:${name}`, SIGNIN_POLICY);
    return attempt.allowed
      ? null
      : tooMany(request, 'Too many sign-in attempts', attempt.retryAfterSeconds);
  }

  const server = Bun.serve({
    fetch: () => new Response('not found', { status: 404 }),
    port: 0,
    routes: {
      '/': new Response('ok'),
      '/api/auth/refresh': {
        POST: async (request) => {
          const input = await guarded(request);
          if (input instanceof Response) {
            return input;
          }
          if (input.credential === null) {
            return error(request, 401, 'Missing or invalid token');
          }
          const claims = await claimsOf(
            input.credential.token,
            sabotage !== 'refresh-ignores-revocation',
          );
          // Like `RefreshUseCase`: the user must still exist with the same id.
          if (claims === null || users.get(claims.name)?.id !== claims.userId) {
            return error(request, 401, 'Invalid or expired token');
          }
          return session(claims.userId, claims.name, 200, {
            id: claims.sessionId,
            startedAt: claims.sessionStartedAt,
          });
        },
      },
      '/api/auth/sign-in': {
        POST: async (request) => {
          const input = await credentials(request);
          if (input instanceof Response) {
            return input;
          }
          const throttled = await signInThrottled(request, input.name);
          if (throttled) {
            return throttled;
          }
          const stored = users.get(input.name);
          if (stored === undefined) {
            unknownSignIns += 1;
            return sabotage === 'unknown-user-accepted'
              ? session(allocateId(), input.name, 200)
              : error(request, 401, 'Invalid credentials');
          }
          if (stored.password !== input.password || sabotage === 'sign-in-401') {
            return error(request, 401, 'Invalid credentials');
          }
          if (conflicted.delete(input.name)) {
            poolReuses += 1;
          }
          return session(stored.id, input.name, 200);
        },
      },
      '/api/auth/sign-out': {
        // Like `createSignOutController`: both cookies are cleared whatever the outcome.
        POST: async (request) => {
          const input = await guarded(request);
          if (input instanceof Response) {
            return input;
          }
          const claims =
            input.credential === null ? null : await claimsOf(input.credential.token, true);
          let response: Response;
          if (claims === null) {
            response = error(request, 401, 'Invalid or expired token');
          } else {
            revoked.add(claims.sessionId);
            response = new Response(null, { status: 204 });
          }
          if (sabotage !== 'sign-out-keeps-cookies') {
            for (const cookie of clearedCookies()) {
              response.headers.append('set-cookie', cookie);
            }
          }
          return response;
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
            users.set(input.name, { id: allocateId(), password: PASSWORD });
          }
          if (sabotage === 'pool-wrong-password' && /p[0-9]+$/u.test(input.name)) {
            users.set(input.name, { id: allocateId(), password: `${PASSWORD}-changed` });
          }
          if (users.has(input.name)) {
            conflicted.add(input.name);
            return error(request, 409, 'User already exists');
          }
          const id = allocateId();
          users.set(input.name, { id, password: input.password });
          return session(id, input.name, 201);
        },
      },
      // One protected GET, behind the real `authenticated` guard (safe method: no origin check).
      '/api/rooms': {
        GET: async (request) => {
          const limited = await rateLimited(request);
          if (limited) {
            return limited;
          }
          const credential = credentialOf(request);
          const claims =
            credential === null
              ? null
              : await claimsOf(credential.token, sabotage !== 'rooms-ignores-revocation');
          return claims === null
            ? error(request, 401, 'Missing or invalid token')
            : Response.json([]);
        },
      },
    },
  });

  return {
    baseUrl: `http://localhost:${server.port}`,
    poolReuses: () => poolReuses,
    resetIpRateLimits: () => {
      limiter = new InMemoryRateLimiter();
    },
    resetRateLimits: () => {
      limiter = new InMemoryRateLimiter();
      signInLimiter = new InMemoryRateLimiter();
    },
    stop: async () => server.stop(true),
    unknownSignIns: () => unknownSignIns,
  };
}

/** Like the real `credentialOf`: the bearer header wins over the `chat_rsa_session` cookie. */
function credentialOf(request: Request): Credential | null {
  const bearer = BEARER.exec(request.headers.get('authorization') ?? '')?.groups?.token;
  if (bearer !== undefined) {
    return { token: bearer, via: 'bearer' };
  }
  const cookie = new Bun.CookieMap(request.headers.get('cookie') ?? '').get('chat_rsa_session');
  return cookie === null || cookie === '' ? null : { token: cookie, via: 'cookie' };
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

async function tokenFor(
  sabotage: Sabotage,
  id: number,
  name: string,
  existing?: SessionRef,
): Promise<string> {
  // Each JWT sabotage breaks exactly one claim, so every claim check is proven on its own.
  const key = new TextEncoder().encode(FAKE_JWT_SECRET);
  const sid = existing?.id ?? crypto.randomUUID();
  const sst = Math.floor((existing?.startedAt.getTime() ?? Date.now()) / 1000);
  if (sabotage === 'broken-jwt-claims') {
    // Correctly signed HS256 with `sub` and `name`, but no `exp`: JoseTokenVerifier refuses it.
    return new SignJWT({ name, sid, sst })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(id))
      .sign(key);
  }
  if (sabotage === 'jwt-no-sid' || sabotage === 'jwt-no-sst') {
    // Everything the real issuer signs except the session id, or the session start.
    return new SignJWT(sabotage === 'jwt-no-sid' ? { name, sst } : { name, sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(id))
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
      .sign(key);
  }
  if (sabotage === 'jwt-expired') {
    return new SignJWT({ name, sid, sst })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(id))
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
  }
  if (sabotage === 'jwt-wrong-alg') {
    return new SignJWT({ name, sid, sst })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(String(id))
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(FAKE_JWT_SECRET.repeat(2)));
  }
  if (sabotage === 'jwt-wrong-name') {
    const { token } = await issuer.issue(userOf(id, `${name}x`), existing);
    return token;
  }
  if (sabotage === 'garbage-token') {
    return 'garbage';
  }
  if (sabotage === 'jwt-not-json') {
    return 'undefined.undefined.undefined';
  }
  const { token } = await issuer.issue(
    userOf(sabotage === 'jwt-wrong-subject' ? id + 1000 : id, name),
    existing,
  );
  return token;
}

/** The `exp` claim of a (possibly sabotaged) token, or null when it has none. */
function expOf(token: string): unknown {
  try {
    return decodeJwt(token).exp ?? null;
  } catch {
    return null;
  }
}

/** Per-cookie attributes of the real `sessionCookies`, each sabotage breaking one of them. */
const COOKIE_ATTRIBUTE_SABOTAGES: Partial<
  Record<Sabotage, { readonly attributes: string; readonly cookie: 'both' | 'hint' | 'session' }>
> = {
  'cookie-path-not-root': {
    attributes: `Secure; SameSite=Strict; Path=/api; Max-Age=${TOKEN_LIFETIME_SECONDS}`,
    cookie: 'both',
  },
  'cookie-samesite-lax': {
    attributes: `Secure; SameSite=Lax; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS}`,
    cookie: 'both',
  },
  'hint-cookie-httponly': {
    attributes: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS}`,
    cookie: 'hint',
  },
  'hint-cookie-not-secure': {
    attributes: `SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS}`,
    cookie: 'hint',
  },
  'hint-cookie-wrong-max-age': {
    attributes: `Secure; SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS * 2}`,
    cookie: 'hint',
  },
  'session-cookie-not-secure': {
    attributes: `SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS}`,
    cookie: 'session',
  },
  'session-cookie-wrong-max-age': {
    attributes: `Secure; SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS * 2}`,
    cookie: 'session',
  },
};

/** The two cookies of the real `sessionCookies`, each sabotage breaking one attribute. */
function sessionCookies(sabotage: Sabotage, token: string): readonly string[] {
  const attributes = `Secure; SameSite=Strict; Path=/; Max-Age=${TOKEN_LIFETIME_SECONDS}`;
  const broken = COOKIE_ATTRIBUTE_SABOTAGES[sabotage];
  const sessionAttributes =
    broken?.cookie === 'hint' ? attributes : (broken?.attributes ?? attributes);
  const hintAttributes =
    broken?.cookie === 'session' ? attributes : (broken?.attributes ?? attributes);
  const exp = expOf(token);
  const hint = sabotage === 'hint-cookie-mismatch' ? Number(exp) + 60 : exp;
  const httpOnly = sabotage === 'session-cookie-not-httponly' ? '' : 'HttpOnly; ';
  return [
    `chat_rsa_session=${token}; ${httpOnly}${sessionAttributes}`,
    `chat_rsa_session_hint=${String(hint)}; ${hintAttributes}`,
  ];
}

/** The real `clearedSessionCookies`: both cookies, expired now. */
function clearedCookies(): readonly string[] {
  return [
    'chat_rsa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    'chat_rsa_session_hint=; Secure; SameSite=Strict; Path=/; Max-Age=0',
  ];
}

function userOf(id: number, name: string): User {
  return new User(UserId.restore(id), UserName.restore(name), PasswordHash.restore('unused'));
}
