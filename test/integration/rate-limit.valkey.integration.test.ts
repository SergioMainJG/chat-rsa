import { RedisClient } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import {
  type BucketPolicy,
  type BucketState,
  type TakeOutcome,
  takeToken,
} from '../../src/backend/shared/domain/token-bucket.ts';
import { ValkeyRateLimiter } from '../../src/backend/shared/rate-limit/rate-limit.valkey.ts';

const client = new RedisClient(loadConfig().cacheUrl);
const runId = crypto.randomUUID();
const used: string[] = [];

function keyFor(name: string): string {
  const key = `test:${runId}:${name}`;
  used.push(`rl:${key}`);
  return key;
}

afterAll(async () => {
  if (used.length > 0) {
    await client.del(...used);
  }
  client.close();
});

async function allowedOf(pending: Promise<TakeOutcome>): Promise<boolean> {
  const outcome = await pending;
  return outcome.allowed;
}

describe('ValkeyRateLimiter', () => {
  test('allows a burst up to capacity, then refuses with Retry-After, then refills', async () => {
    let now = 1_000_000;
    const limiter = new ValkeyRateLimiter(client, () => now);
    const key = keyFor('burst');
    const policy = { capacity: 3, refillPerSecond: 0.5 };

    const burst = await Promise.all([1, 2, 3].map(async () => limiter.take(key, policy)));
    expect(burst.map((outcome) => outcome.allowed)).toEqual([true, true, true]);

    const refused = await limiter.take(key, policy);
    expect(refused).toMatchObject({ allowed: false, retryAfterSeconds: 2 });

    now += 2000;
    expect(await allowedOf(limiter.take(key, policy))).toBe(true);
    expect(await allowedOf(limiter.take(key, policy))).toBe(false);
  });

  test('stores the key under the rl: prefix with a TTL', async () => {
    const limiter = new ValkeyRateLimiter(client, () => 5000);
    const key = keyFor('ttl');

    await limiter.take(key, { capacity: 10, refillPerSecond: 2 });

    const ttl: unknown = await client.send('PTTL', [`rl:${key}`]);
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5000);
  });

  test('matches takeToken step by step, including fractional refills and a clock going back', async () => {
    const policy: BucketPolicy = { capacity: 4, refillPerSecond: 3 };
    const times = [0, 10, 20, 30, 40, 50, 377, 378, 1234, 1000, 5000, 5001, 5002, 5003, 5004, 5005];
    let now = 0;
    const limiter = new ValkeyRateLimiter(client, () => now);
    const key = keyFor('parity');
    let state: BucketState | null = null;

    for (const time of times) {
      now = time;
      const expected = takeToken(state, policy, time);
      // Sequential on purpose: each step depends on the state the previous one stored.
      // eslint-disable-next-line no-await-in-loop
      const actual = await limiter.take(key, policy);
      expect(actual).toEqual(expected);
      ({ state } = expected);
    }
  });

  test('is atomic under concurrent takes on one key', async () => {
    const limiter = new ValkeyRateLimiter(client, () => 42);
    const key = keyFor('race');
    const policy = { capacity: 5, refillPerSecond: 1 };

    const outcomes = await Promise.all(Array.from({ length: 20 }, async () => limiter.take(key, policy)));

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(5);
  });
});
