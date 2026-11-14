import { isIP } from 'node:net';

import type { TokenVerifier } from '../../user/domain/user.security.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { Logger } from '../domain/logger.ts';
import type { BucketPolicy } from '../domain/token-bucket.ts';
import type { RateLimiter } from '../rate-limit/rate-limit.port.ts';

import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../domain/app.error.ts';
import { cookieOf, SESSION_COOKIE } from './http.cookies.ts';
import { isUnsafeMethod, originOf } from './http.origin.ts';
import { respond } from './http.respond.ts';

/** A route handler that only runs for a verified user. */
export type AuthenticatedHandler<R extends Request> = (
  request: R,
  actor: UserId,
) => Promise<Response> | Response;

/** Where a request's token came from: a programmatic client's header, or a browser's cookie. */
export type Credential = {
  readonly token: string;
  readonly via: 'bearer' | 'cookie';
};

export type GuardDependencies = {
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** `APP_ORIGINS`: the only origins an unsafe request may come from. */
  readonly origins: readonly string[];
  readonly policies: GuardPolicies;
  /** `TRUSTED_PROXY_IPS`: peers whose `CF-Connecting-IP` header names the client. */
  readonly trustedProxyIps: readonly string[];
  readonly verifier: TokenVerifier;
};

export type GuardPolicies = {
  readonly ip: BucketPolicy;
  readonly user: BucketPolicy;
};

export type Guards = {
  /**
   * IP bucket, then the origin check (403), then the token from the bearer header or the session
   * cookie (401), then the user bucket, then the handler.
   */
  readonly authenticated: <R extends Request>(handler: AuthenticatedHandler<R>) => GuardedRoute<R>;
  /**
   * IP bucket and origin check, then the handler with the request's token (or null) unverified: for
   * refresh and sign-out, whose use cases verify it themselves.
   */
  readonly session: <R extends Request>(handler: SessionHandler<R>) => GuardedRoute<R>;
  /**
   * IP bucket only, for the `/ws` upgrade: the handler answers `undefined` once upgraded, so a 429
   * is returned before the gateway verifies the token or queries the rooms.
   */
  readonly upgrade: <S extends RequestIpSource>(handler: UpgradeHandler<S>) => UpgradeRoute<S>;
  /** IP bucket and origin check, for routes reached before signing in. */
  readonly public: <R extends Request>(handler: PublicHandler<R>) => GuardedRoute<R>;
};

/** What Bun passes as the second argument of a route handler. */
export type GuardedRoute<R extends Request> = (
  request: R,
  server: RequestIpSource,
) => Promise<Response>;

export type PublicHandler<R extends Request> = (request: R) => Promise<Response> | Response;

/** The part of `Bun.Server` the guard needs; `null` when the peer address is unknown. */
export type RequestIpSource = {
  readonly requestIP: (request: Request) => null | { readonly address: string };
};

export type SessionHandler<R extends Request> = (
  request: R,
  token: null | string,
) => Promise<Response> | Response;

export type UpgradeHandler<S extends RequestIpSource> = (
  request: Request,
  server: S,
) => Promise<Response | undefined>;

export type UpgradeRoute<S extends RequestIpSource> = (
  request: Request,
  server: S,
) => Promise<Response | undefined>;

const BEARER = /^Bearer (?<token>\S+)$/iu;

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerTokenOf(request: Request): null | string {
  return BEARER.exec(request.headers.get('authorization') ?? '')?.groups?.token ?? null;
}

/**
 * The token of a request: the `Authorization: Bearer` header when there is one (tests, k6), else
 * the `chat_rsa_session` cookie (browsers).
 */
export function credentialOf(request: Request): Credential | null {
  const bearer = bearerTokenOf(request);
  if (bearer !== null) {
    return { token: bearer, via: 'bearer' };
  }
  const cookie = cookieOf(request, SESSION_COOKIE);
  return cookie === null ? null : { token: cookie, via: 'cookie' };
}

/**
 * The IP a request is rate-limited under: the socket peer, or the `CF-Connecting-IP` header when
 * the peer is a trusted proxy and the header holds a valid IP. `X-Forwarded-For` is ignored.
 */
export function clientIpOf(
  request: Request,
  server: RequestIpSource,
  trustedProxyIps: ReadonlySet<string>,
): string {
  const peer = server.requestIP(request)?.address;
  if (peer === undefined) {
    return 'unknown';
  }
  if (trustedProxyIps.has(peer) || trustedProxyIps.has(peer.replace(/^::ffff:/iu, ''))) {
    const forwarded = request.headers.get('cf-connecting-ip')?.trim() ?? '';
    if (isIP(forwarded) !== 0) {
      return forwarded;
    }
  }
  return peer;
}

/** Sentinel response meaning "the IP bucket allowed it"; never sent to a client. */
const ALLOWED = new Response(null, { status: 204 });

/**
 * Zero-trust guards: every request spends a token from its IP bucket, and an authenticated one also
 * from its user bucket, so one user cannot spread a flood over many IPs. The IP comes from the
 * socket (or a trusted proxy's `CF-Connecting-IP`), never from `X-Forwarded-For`, which a client
 * can forge. Unsafe methods must come from an allowed origin (CSRF): a foreign `Origin` is refused,
 * and so is a cookie-authenticated request without one.
 */
export function createGuards({
  limiter,
  logger,
  origins,
  policies,
  trustedProxyIps,
  verifier,
}: GuardDependencies): Guards {
  const trusted = new Set(trustedProxyIps);

  function checkOrigin(request: Request, credential: Credential | null): void {
    if (!isUnsafeMethod(request)) {
      return;
    }
    const origin = originOf(request);
    const refused = origin === null ? credential?.via === 'cookie' : !origins.includes(origin);
    if (refused) {
      throw new ForbiddenError('Origin not allowed');
    }
  }

  async function spend(key: string, policy: BucketPolicy): Promise<void> {
    const outcome = await limiter.take(key, policy);
    if (!outcome.allowed) {
      throw new TooManyRequestsError('Too many requests', outcome.retryAfterSeconds);
    }
  }

  async function spendIp(request: Request, server: RequestIpSource): Promise<void> {
    await spend(`ip:${clientIpOf(request, server, trusted)}`, policies.ip);
  }

  async function actorOf(credential: Credential | null): Promise<UserId> {
    const claims = credential === null ? null : await verifier.verify(credential.token);
    if (!claims) {
      throw new UnauthorizedError('Missing or invalid token');
    }
    return claims.userId;
  }

  return {
    authenticated: (handler) => async (request, server) =>
      respond(request, logger, async () => {
        await spendIp(request, server);
        const credential = credentialOf(request);
        checkOrigin(request, credential);
        const actor = await actorOf(credential);
        await spend(`user:${actor}`, policies.user);
        return handler(request, actor);
      }),
    public: (handler) => async (request, server) =>
      respond(request, logger, async () => {
        await spendIp(request, server);
        checkOrigin(request, null);
        return handler(request);
      }),
    session: (handler) => async (request, server) =>
      respond(request, logger, async () => {
        await spendIp(request, server);
        const credential = credentialOf(request);
        checkOrigin(request, credential);
        return handler(request, credential?.token ?? null);
      }),
    upgrade: (handler) => async (request, server) => {
      const limited = await respond(request, logger, async () => {
        await spendIp(request, server);
        return ALLOWED;
      });
      return limited === ALLOWED ? handler(request, server) : limited;
    },
  };
}
