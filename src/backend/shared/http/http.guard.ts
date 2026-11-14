import type { TokenVerifier } from '../../user/domain/user.security.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { Logger } from '../domain/logger.ts';
import type { BucketPolicy } from '../domain/token-bucket.ts';
import type { RateLimiter } from '../rate-limit/rate-limit.port.ts';

import { TooManyRequestsError, UnauthorizedError } from '../domain/app.error.ts';
import { respond } from './http.respond.ts';

/** A route handler that only runs for a verified user. */
export type AuthenticatedHandler<R extends Request> = (
  request: R,
  actor: UserId,
) => Promise<Response> | Response;

export type GuardDependencies = {
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly policies: GuardPolicies;
  readonly verifier: TokenVerifier;
};

export type GuardPolicies = {
  readonly ip: BucketPolicy;
  readonly user: BucketPolicy;
};

export type Guards = {
  /** IP bucket, then the bearer token (401), then the user bucket, then the handler. */
  readonly authenticated: <R extends Request>(handler: AuthenticatedHandler<R>) => GuardedRoute<R>;
  /**
   * IP bucket only, for the `/ws` upgrade: the handler answers `undefined` once upgraded, so a 429
   * is returned before the gateway verifies the token or queries the rooms.
   */
  readonly upgrade: <S extends RequestIpSource>(handler: UpgradeHandler<S>) => UpgradeRoute<S>;
  /** IP bucket only, for routes reached before signing in. */
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

/** Sentinel response meaning "the IP bucket allowed it"; never sent to a client. */
const ALLOWED = new Response(null, { status: 204 });

/**
 * Zero-trust guards: every request spends a token from its IP bucket, and an authenticated one also
 * from its user bucket, so one user cannot spread a flood over many IPs. The IP comes from the
 * socket, never from `X-Forwarded-For`, which a client can forge.
 */
export function createGuards({ limiter, logger, policies, verifier }: GuardDependencies): Guards {
  async function spend(key: string, policy: BucketPolicy): Promise<void> {
    const outcome = await limiter.take(key, policy);
    if (!outcome.allowed) {
      throw new TooManyRequestsError('Too many requests', outcome.retryAfterSeconds);
    }
  }

  async function spendIp(request: Request, server: RequestIpSource): Promise<void> {
    await spend(`ip:${server.requestIP(request)?.address ?? 'unknown'}`, policies.ip);
  }

  async function actorOf(request: Request): Promise<UserId> {
    const token = bearerTokenOf(request);
    const claims = token === null ? null : await verifier.verify(token);
    if (!claims) {
      throw new UnauthorizedError('Missing or invalid token');
    }
    return claims.userId;
  }

  return {
    authenticated: (handler) => async (request, server) =>
      respond(request, logger, async () => {
        await spendIp(request, server);
        const actor = await actorOf(request);
        await spend(`user:${actor}`, policies.user);
        return handler(request, actor);
      }),
    public: (handler) => async (request, server) =>
      respond(request, logger, async () => {
        await spendIp(request, server);
        return handler(request);
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
