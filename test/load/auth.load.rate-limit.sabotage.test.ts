import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  crossed,
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// BUG-CRITICAL-03 (load run 2), part 2: the real server puts sign-in and sign-up behind an IP token
// bucket. The fake models it with the server's own default policy, and the `stress` profile proves
// that a burst past the bucket gets 429 with an integer Retry-After and the shared error format.

const RATE_LIMIT_CHECK = 'rate limit is 429 with Retry-After';

async function stressAgainst(sabotage: Sabotage): Promise<ProbeRun> {
  const fake = startFakeAuthServer(sabotage);
  try {
    return await runK6Against(fake, { profile: 'stress' });
  } finally {
    await fake.stop();
  }
}

describe('fake auth server rate limiting', () => {
  test('answers 429 with Retry-After and the error format past the default IP bucket', async () => {
    const fake = startFakeAuthServer('honest');
    const { capacity } = loadConfig({}).rateLimit.ip;
    try {
      const statuses: number[] = [];
      let limited: null | Response = null;
      for (let index = 0; index <= capacity; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`${fake.baseUrl}/api/auth/sign-in`, {
          body: JSON.stringify({ name: 'has space', password: 'x' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        statuses.push(response.status);
        limited = response;
      }
      expect(statuses.filter((status) => status === 400)).toHaveLength(capacity);
      expect(statuses.at(-1)).toBe(429);
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await limited?.json()).toMatchObject({
        error: 'Too Many Requests',
        path: '/api/auth/sign-in',
        statusCode: 429,
      });
    } finally {
      await fake.stop();
    }
  });
});

describe('k6 stress profile against a rate-limited server', () => {
  test(
    'L-07: the burst is shed with well-formed 429s, and the saturated spike fails on purpose',
    async () => {
      const outcome = await stressAgainst('honest');

      expect(outcome.summary?.metrics['http_req_duration{scenario:spike}']).toBeDefined();
      expect(outcome.summary?.metrics.rate_limited?.count ?? 0).toBeGreaterThan(0);
      expect(crossed(outcome, 'rate_limited')).toBe(false);
      expect(failedChecks(outcome)).not.toContain(RATE_LIMIT_CHECK);
      // A spike past the bucket gets 429s on valid sign-ins: that is the documented failure.
      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'http_req_failed')).toBe(true);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'a server that never rate-limits fails the rate_limited threshold',
    async () => {
      const outcome = await stressAgainst('no-rate-limit');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'rate_limited')).toBe(true);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'a 429 without Retry-After fails the rate-limit check',
    async () => {
      const outcome = await stressAgainst('rate-limit-no-retry-after');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toContain(RATE_LIMIT_CHECK);
    },
    K6_TIMEOUT_MS,
  );
});
