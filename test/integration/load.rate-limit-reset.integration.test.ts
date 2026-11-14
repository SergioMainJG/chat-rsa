import { RedisClient } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { RATE_LIMIT_KEY_PREFIX, ValkeyRateLimiter } from '../../src/backend/shared/rate-limit/rate-limit.valkey.ts';
import { newRunId } from '../load/k6-runner.ts';
import { LOOPBACK_ADDRESSES, resetRateLimits } from '../load/load.cleanup.ts';

// BUG-CRITICAL-03 (load run 2), part 1: consecutive load runs from localhost exhausted the shared IP
// bucket and failed with 429. Between runs, the load script resets exactly the loopback IP buckets
// and the buckets of the run's own users, and nothing else.

const client = new RedisClient(loadConfig().cacheUrl);
const limiter = new ValkeyRateLimiter(client);
const POLICY = { capacity: 2, refillPerSecond: 0.001 };
const RUN_USERS = [900_000_001, 900_000_002];
const FOREIGN = ['ip:10.1.2.3', 'user:900000003'];
const RUN_ID = newRunId();
const OTHER_RUN_ID = newRunId();
/** Pool, sign-up, messaging and never-registered names of this run. */
const RUN_SIGNIN_NAMES = ['p0', 'u12', 'm3', 'nobody'].map((suffix) => `load${RUN_ID}${suffix}`);
const FOREIGN_SIGNIN_NAMES = [`load${OTHER_RUN_ID}p0`, 'alice', `xload${RUN_ID}p0`];

afterAll(async () => {
  for (const key of [
    ...LOOPBACK_ADDRESSES.map((address) => `ip:${address}`),
    ...FOREIGN,
    ...RUN_USERS.map((id) => `user:${id}`),
    ...[...RUN_SIGNIN_NAMES, ...FOREIGN_SIGNIN_NAMES].map((name) => `signin:${name}`),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await client.del(`${RATE_LIMIT_KEY_PREFIX}${key}`);
  }
  client.close();
});

async function allowed(key: string): Promise<boolean> {
  const outcome = await limiter.take(key, POLICY);
  return outcome.allowed;
}

async function exhaust(key: string): Promise<void> {
  for (let index = 0; index <= POLICY.capacity; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await limiter.take(key, POLICY);
  }
  const outcome = await limiter.take(key, POLICY);
  expect(outcome.allowed).toBe(false);
}

describe('resetRateLimits', () => {
  test('refills the loopback IP buckets and the run users’ buckets', async () => {
    const keys = [...LOOPBACK_ADDRESSES.map((address) => `ip:${address}`), ...RUN_USERS.map((id) => `user:${id}`)];
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await exhaust(key);
    }

    await resetRateLimits(client, RUN_USERS, RUN_ID);

    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      expect(await allowed(key)).toBe(true);
    }
  });

  test('leaves other clients’ and other users’ buckets exhausted', async () => {
    for (const key of FOREIGN) {
      // eslint-disable-next-line no-await-in-loop
      await exhaust(key);
    }

    await resetRateLimits(client, RUN_USERS, RUN_ID);

    for (const key of FOREIGN) {
      // eslint-disable-next-line no-await-in-loop
      expect(await allowed(key)).toBe(false);
    }
  });

  // BUG-LOAD-RUN3-CRIT-01: the per-account sign-in buckets (`signin:<name>`, 10 attempts then one
  // per 30 s) of the run's names stayed exhausted for minutes, so a rerun failed with 429.
  test('refills the sign-in buckets of every name of the run, registered or not', async () => {
    const keys = RUN_SIGNIN_NAMES.map((name) => `signin:${name}`);
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await exhaust(key);
    }

    await resetRateLimits(client, RUN_USERS, RUN_ID);

    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      expect(await allowed(key)).toBe(true);
    }
  });

  test('leaves the sign-in buckets of other names and other runs exhausted', async () => {
    const keys = FOREIGN_SIGNIN_NAMES.map((name) => `signin:${name}`);
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await exhaust(key);
    }

    await resetRateLimits(client, RUN_USERS, RUN_ID);

    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      expect(await allowed(key)).toBe(false);
    }
  });

  test('refuses a malformed runId instead of widening the match', async () => {
    let rejection: unknown = null;
    try {
      await resetRateLimits(client, RUN_USERS, '*');
    } catch (error) {
      rejection = error;
    }
    expect(String(rejection)).toContain('Refusing to build a delete pattern');
  });

  test('covers the IPv4, IPv6 and IPv4-mapped loopback addresses a local k6 can come from', () => {
    expect([...LOOPBACK_ADDRESSES].toSorted()).toEqual(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  });
});
