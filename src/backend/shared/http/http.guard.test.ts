import { describe, expect, test } from 'bun:test';

import type { Logger } from '../domain/logger.ts';

import { type TokenClaims, TokenVerifier } from '../../user/domain/user.security.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { ConflictError } from '../domain/app.error.ts';
import { InMemoryRateLimiter } from '../rate-limit/rate-limit.in-memory.ts';
import { bearerTokenOf, createGuards, type GuardPolicies, type RequestIpSource } from './http.guard.ts';

class FakeVerifier extends TokenVerifier {
  calls = 0;

  constructor(private readonly valid: ReadonlyMap<string, number>) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake of an async port
  override async verify(token: string): Promise<null | TokenClaims> {
    this.calls += 1;
    const userId = this.valid.get(token);
    return userId === undefined
      ? null
      : {
          expiresAt: new Date(Date.now() + 60_000),
          name: `user${userId}`,
          sessionId: `s${userId}`,
          sessionStartedAt: new Date(),
          userId: UserId.restore(userId),
        };
  }
}

function get(token?: string): Request {
  return new Request('http://localhost/api/rooms', {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

function serverAt(address: string): RequestIpSource {
  return { requestIP: () => ({ address }) };
}

const DEFAULT_POLICIES = { ip: { capacity: 5, refillPerSecond: 1 }, user: { capacity: 5, refillPerSecond: 1 } };
const ORIGIN = 'http://localhost:3000';
const PROXY = '10.9.9.9';

function setup(policies: GuardPolicies = DEFAULT_POLICIES): {
  readonly guards: ReturnType<typeof createGuards>;
  readonly logged: unknown[];
  readonly seen: number[];
  readonly verifier: FakeVerifier;
} {
  const logged: unknown[] = [];
  const logger: Logger = {
    error: (error) => {
      logged.push(error);
    },
  };
  const verifier = new FakeVerifier(
    new Map([
      ['alice', 1],
      ['bob', 2],
    ]),
  );
  const guards = createGuards({
    limiter: new InMemoryRateLimiter(() => 0),
    logger,
    origins: [ORIGIN],
    policies,
    trustedProxyIps: [PROXY],
    verifier,
  });
  return { guards, logged, seen: [], verifier };
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

describe('authenticated guard', () => {
  test('calls the handler with the actor of a valid bearer token', async () => {
    const { guards, seen } = setup();
    const handler = guards.authenticated(async (_request, actor) => {
      seen.push(actor);
      return Response.json({ ok: true });
    });

    const response = await handler(get('alice'), serverAt('10.0.0.1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([1]);
  });

  test.each([
    ['a missing header', undefined],
    ['an invalid token', 'forged'],
  ])('answers 401 for %s without calling the handler', async (_label, token) => {
    const { guards, seen } = setup();
    const handler = guards.authenticated(async (_request, actor) => {
      seen.push(actor);
      return new Response('nope');
    });

    const response = await handler(get(token), serverAt('10.0.0.1'));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: 'Missing or invalid token', statusCode: 401 });
    expect(seen).toEqual([]);
  });

  test('an exhausted IP bucket answers 429 with Retry-After before the token is checked', async () => {
    const { guards, verifier } = setup({
      ip: { capacity: 1, refillPerSecond: 0.25 },
      user: { capacity: 10, refillPerSecond: 1 },
    });
    const handler = guards.authenticated(async () => new Response('ok'));

    expect(await statusOf(handler(get('alice'), serverAt('10.0.0.1')))).toBe(200);
    const refused = await handler(get('alice'), serverAt('10.0.0.1'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('4');
    expect(await refused.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
    expect(verifier.calls).toBe(1);
    expect(await statusOf(handler(get('alice'), serverAt('10.0.0.2')))).toBe(200);
  });

  test('an exhausted user bucket answers 429 even from a fresh IP', async () => {
    const { guards } = setup({ ip: { capacity: 10, refillPerSecond: 1 }, user: { capacity: 1, refillPerSecond: 1 } });
    const handler = guards.authenticated(async () => new Response('ok'));

    expect(await statusOf(handler(get('alice'), serverAt('10.0.0.1')))).toBe(200);
    const refused = await handler(get('alice'), serverAt('10.0.0.2'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await statusOf(handler(get('bob'), serverAt('10.0.0.3')))).toBe(200);
  });

  test('renders an AppError thrown by the handler and hides anything else behind a logged 500', async () => {
    const { guards, logged } = setup();
    const failure = new Error('db down');
    const conflict = guards.authenticated(() => {
      throw new ConflictError('taken');
    });
    const crash = guards.authenticated(() => {
      throw failure;
    });

    expect(await statusOf(conflict(get('alice'), serverAt('10.0.0.1')))).toBe(409);
    expect(await statusOf(crash(get('alice'), serverAt('10.0.0.1')))).toBe(500);
    expect(logged).toEqual([failure]);
  });
});

describe('public guard', () => {
  test('applies only the IP bucket', async () => {
    const { guards, verifier } = setup({
      ip: { capacity: 1, refillPerSecond: 1 },
      user: { capacity: 1, refillPerSecond: 1 },
    });
    const handler = guards.public(async () => new Response('ok'));

    expect(await statusOf(handler(get(), serverAt('10.0.0.1')))).toBe(200);
    const refused = await handler(get(), serverAt('10.0.0.1'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(verifier.calls).toBe(0);
  });

  test('buckets clients whose IP is unknown together', async () => {
    const { guards } = setup({ ip: { capacity: 1, refillPerSecond: 1 }, user: { capacity: 1, refillPerSecond: 1 } });
    const handler = guards.public(async () => new Response('ok'));
    const unknown: RequestIpSource = { requestIP: () => null };

    expect(await statusOf(handler(get(), unknown))).toBe(200);
    expect(await statusOf(handler(get(), unknown))).toBe(429);
  });
});

describe('bearerTokenOf', () => {
  test.each([
    ['Bearer abc.def', 'abc.def'],
    ['bearer abc', 'abc'],
    ['Basic abc', null],
    ['Bearer ', null],
    ['Bearer a b', null],
    ['Foo Bearer abc', null],
  ])('reads %p as %p', (header, expected) => {
    expect(bearerTokenOf(new Request('http://localhost/', { headers: { authorization: header } }))).toBe(expected);
  });
});

describe('upgrade guard', () => {
  test('spends the IP bucket before the upgrade and answers 429 once it is empty', async () => {
    const { guards } = setup({ ip: { capacity: 2, refillPerSecond: 1 }, user: DEFAULT_POLICIES.user });
    let upgrades = 0;
    const upgraded = new Response('upgraded');
    const upgrade = guards.upgrade(async () => {
      upgrades += 1;
      return upgraded;
    });
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- the bucket is spent in order
      results.push(await upgrade(get(), serverAt('10.0.0.9')));
    }
    expect(results.slice(0, 2)).toEqual([upgraded, upgraded]);
    expect(results[2]?.status).toBe(429);
    expect(results[2]?.headers.get('retry-after')).toBe('1');
    expect(upgrades).toBe(2);
  });
});

function request(method: string, headers: Record<string, string>, path = '/api/rooms'): Request {
  return new Request(`http://localhost${path}`, { headers, method });
}

const ONE_REQUEST_PER_IP = { ip: { capacity: 1, refillPerSecond: 0.001 }, user: { capacity: 99, refillPerSecond: 1 } };

describe('client IP (TRUSTED_PROXY_IPS + CF-Connecting-IP)', () => {
  type Route = (request: Request, server: RequestIpSource) => Promise<Response | undefined>;
  const routes: ReadonlyArray<[string, (guards: ReturnType<typeof createGuards>) => Route]> = [
    ['authenticated', (guards) => guards.authenticated(async () => new Response('ok'))],
    ['public', (guards) => guards.public(async () => new Response('ok'))],
    ['session', (guards) => guards.session(async () => new Response('ok'))],
    ['upgrade', (guards) => guards.upgrade(async () => new Response('ok'))],
  ];

  async function secondStatus(route: Route, first: Request, second: Request, peer: string): Promise<number> {
    await route(first, serverAt(peer));
    const response = await route(second, serverAt(peer));
    return response?.status ?? 0;
  }

  const alice = { authorization: 'Bearer alice' };

  test.each(routes)('%s: behind a trusted proxy, two clients get their own buckets', async (_name, make) => {
    const route = make(setup(ONE_REQUEST_PER_IP).guards);
    const status = await secondStatus(
      route,
      request('GET', { ...alice, 'cf-connecting-ip': '203.0.113.1' }),
      request('GET', { ...alice, 'cf-connecting-ip': '203.0.113.2' }),
      PROXY,
    );
    expect(status).toBe(200);
  });

  test.each(routes)('%s: the same CF-Connecting-IP behind the proxy shares one bucket', async (_name, make) => {
    const route = make(setup(ONE_REQUEST_PER_IP).guards);
    const headers = { ...alice, 'cf-connecting-ip': '2001:db8::1' };
    expect(await secondStatus(route, request('GET', headers), request('GET', headers), PROXY)).toBe(429);
  });

  test.each(routes)('%s: an untrusted peer is bucketed by its own address, whatever it claims', async (_name, make) => {
    const route = make(setup(ONE_REQUEST_PER_IP).guards);
    const status = await secondStatus(
      route,
      request('GET', { ...alice, 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.1' }),
      request('GET', { ...alice, 'cf-connecting-ip': '203.0.113.2', 'x-forwarded-for': '198.51.100.2' }),
      '10.0.0.1',
    );
    expect(status).toBe(429);
  });

  test.each([['not-an-ip'], [''], ['203.0.113.1, 203.0.113.2']])(
    'a trusted proxy with an invalid CF-Connecting-IP %p falls back to the peer',
    async (header) => {
      const route = setup(ONE_REQUEST_PER_IP).guards.public(async () => new Response('ok'));
      const status = await secondStatus(
        route,
        request('GET', { 'cf-connecting-ip': header }),
        request('GET', { 'cf-connecting-ip': '203.0.113.9' }),
        PROXY,
      );
      // The first request spent the proxy's own bucket; the second has a valid header of its own.
      expect(status).toBe(200);
      const again = await route(request('GET', { 'cf-connecting-ip': header }), serverAt(PROXY));
      expect(again.status).toBe(429);
      // A different invalid header is not a bucket of its own: it is still the proxy's bucket.
      const other = await route(request('GET', { 'cf-connecting-ip': 'other-garbage' }), serverAt(PROXY));
      expect(other.status).toBe(429);
    },
  );

  test('X-Forwarded-For is ignored even from a trusted proxy', async () => {
    const route = setup(ONE_REQUEST_PER_IP).guards.public(async () => new Response('ok'));
    const status = await secondStatus(
      route,
      request('GET', { 'x-forwarded-for': '203.0.113.1' }),
      request('GET', { 'x-forwarded-for': '203.0.113.2' }),
      PROXY,
    );
    expect(status).toBe(429);
  });

  test('a trusted proxy reached over IPv4-mapped IPv6 is still trusted', async () => {
    const route = setup(ONE_REQUEST_PER_IP).guards.public(async () => new Response('ok'));
    const status = await secondStatus(
      route,
      request('GET', { 'cf-connecting-ip': '203.0.113.1' }),
      request('GET', { 'cf-connecting-ip': '203.0.113.2' }),
      `::ffff:${PROXY}`,
    );
    expect(status).toBe(200);
  });
});

describe('session cookie and CSRF origin checks', () => {
  test('the authenticated guard accepts the chat_rsa_session cookie on a GET without Origin', async () => {
    const { guards, seen } = setup();
    const handler = guards.authenticated(async (_request, actor) => {
      seen.push(actor);
      return new Response('ok');
    });

    const response = await handler(request('GET', { cookie: 'chat_rsa_session=bob' }), serverAt('10.0.0.1'));

    expect(response.status).toBe(200);
    expect(seen).toEqual([2]);
  });

  test('the bearer header wins over the cookie, and the hint cookie is never a credential', async () => {
    const { guards, seen } = setup();
    const handler = guards.authenticated(async (_request, actor) => {
      seen.push(actor);
      return new Response('ok');
    });

    const both = await handler(
      request('GET', { authorization: 'Bearer alice', cookie: 'chat_rsa_session=bob' }),
      serverAt('10.0.0.1'),
    );
    const hintOnly = await handler(request('GET', { cookie: 'chat_rsa_session_hint=alice' }), serverAt('10.0.0.1'));

    expect(both.status).toBe(200);
    expect(seen).toEqual([1]);
    expect(hintOnly.status).toBe(401);
  });

  test.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s with a foreign Origin answers 403 before the handler',
    async (method) => {
      const { guards, seen } = setup();
      const handler = guards.authenticated(async (_request, actor) => {
        seen.push(actor);
        return new Response('ok');
      });

      const response = await handler(
        request(method, { authorization: 'Bearer alice', origin: 'https://evil.example' }),
        serverAt('10.0.0.1'),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'Forbidden',
        message: 'Origin not allowed',
        statusCode: 403,
      });
      expect(seen).toEqual([]);
    },
  );

  test('a cookie-authenticated POST without Origin answers 403; with an allowed Origin it passes', async () => {
    const { guards } = setup();
    const handler = guards.authenticated(async () => new Response('ok'));

    const missing = await handler(request('POST', { cookie: 'chat_rsa_session=alice' }), serverAt('10.0.0.1'));
    const allowed = await handler(
      request('POST', { cookie: 'chat_rsa_session=alice', origin: ORIGIN }),
      serverAt('10.0.0.1'),
    );

    expect(missing.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  test('a bearer POST without Origin still passes (programmatic clients)', async () => {
    const { guards } = setup();
    const handler = guards.authenticated(async () => new Response('ok'));

    expect(await statusOf(handler(request('POST', { authorization: 'Bearer alice' }), serverAt('10.0.0.1')))).toBe(200);
  });

  test('the public guard refuses a foreign Origin on POST and lets a missing or allowed one through', async () => {
    const { guards } = setup();
    const handler = guards.public(async () => new Response('ok'));

    expect(await statusOf(handler(request('POST', { origin: 'null' }), serverAt('10.0.0.1')))).toBe(403);
    expect(await statusOf(handler(request('POST', {}), serverAt('10.0.0.1')))).toBe(200);
    expect(await statusOf(handler(request('POST', { origin: ORIGIN }), serverAt('10.0.0.1')))).toBe(200);
    expect(await statusOf(handler(request('GET', { origin: 'https://evil.example' }), serverAt('10.0.0.1')))).toBe(200);
  });

  test('the session guard hands the unverified bearer or cookie token to the handler, after the origin check', async () => {
    const { guards, verifier } = setup();
    const tokens: Array<null | string> = [];
    const handler = guards.session(async (_request, token) => {
      tokens.push(token);
      return new Response('ok');
    });

    const viaCookie = await handler(
      request('POST', { cookie: 'chat_rsa_session=c.c.c', origin: ORIGIN }),
      serverAt('10.0.0.1'),
    );
    const viaBearer = await handler(request('POST', { authorization: 'Bearer b.b.b' }), serverAt('10.0.0.1'));
    const none = await handler(request('POST', {}), serverAt('10.0.0.1'));
    const forged = await handler(request('POST', { cookie: 'chat_rsa_session=c.c.c' }), serverAt('10.0.0.1'));

    expect([viaCookie.status, viaBearer.status, none.status, forged.status]).toEqual([200, 200, 200, 403]);
    expect(tokens).toEqual(['c.c.c', 'b.b.b', null]);
    expect(verifier.calls).toBe(0);
  });
});
