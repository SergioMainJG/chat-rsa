import { expect, test } from 'bun:test';

import type { TakeOutcome } from '../domain/token-bucket.ts';

import { InMemoryRateLimiter } from './rate-limit.in-memory.ts';

const policy = { capacity: 2, refillPerSecond: 1 };

async function allowedOf(pending: Promise<TakeOutcome>): Promise<boolean> {
  const outcome = await pending;
  return outcome.allowed;
}

test('allows a burst up to capacity, then refuses with Retry-After, then refills', async () => {
  let now = 1000;
  const limiter = new InMemoryRateLimiter(() => now);

  expect(await allowedOf(limiter.take('a', policy))).toBe(true);
  expect(await allowedOf(limiter.take('a', policy))).toBe(true);
  const refused = await limiter.take('a', policy);
  expect(refused).toMatchObject({ allowed: false, retryAfterSeconds: 1 });

  now += 1000;
  expect(await allowedOf(limiter.take('a', policy))).toBe(true);
});

test('keeps a separate bucket per key', async () => {
  const limiter = new InMemoryRateLimiter(() => 0);
  const single = { capacity: 1, refillPerSecond: 1 };

  expect(await allowedOf(limiter.take('a', single))).toBe(true);
  expect(await allowedOf(limiter.take('b', single))).toBe(true);
  expect(await allowedOf(limiter.take('a', single))).toBe(false);
});
