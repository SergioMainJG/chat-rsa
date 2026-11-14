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
  const guards = createGuards({ limiter: new InMemoryRateLimiter(() => 0), logger, policies, verifier });
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
