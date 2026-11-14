import { describe, expect, test } from 'bun:test';

import { newRunId } from './k6-runner.ts';
import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import { failedChecks, K6_TIMEOUT_MS, runK6Against, SCRIPT_EXCEPTION } from './support/k6-probe.test-support.ts';

// BUG-HIGH-05 (load run 2): a run retried with the same RUN_ID must really reuse the 20 pool users
// (verified by signing in with the known password), must stop when a leftover pool user has a
// different password, and its sign-ups must not collide with the users of the first attempt.

const POOL_SIZE = 20;

async function probe(sabotage: Sabotage): Promise<{ exitCode: number; poolReuses: number }> {
  const fake = startFakeAuthServer(sabotage);
  try {
    const { exitCode } = await runK6Against(fake);
    return { exitCode, poolReuses: fake.poolReuses() };
  } finally {
    await fake.stop();
  }
}

describe('sign-in pool left by an aborted run', () => {
  test(
    'L-02: every leftover pool user is reused through a sign-in with the known password',
    async () => {
      const outcome = await probe('pool-exists');

      expect(outcome.exitCode).toBe(0);
      expect(outcome.poolReuses).toBe(POOL_SIZE);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'a fresh server needs no reuse at all',
    async () => {
      const outcome = await probe('honest');

      expect(outcome.exitCode).toBe(0);
      expect(outcome.poolReuses).toBe(0);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'a leftover pool user whose password changed stops setup() with a script exception',
    async () => {
      const outcome = await probe('pool-wrong-password');

      expect(outcome.exitCode).toBe(SCRIPT_EXCEPTION);
      expect(outcome.poolReuses).toBe(0);
    },
    K6_TIMEOUT_MS,
  );
});

describe('a run retried with the same RUN_ID', () => {
  test(
    'passes again: the pool is reused and the sign-ups do not collide with the first attempt',
    async () => {
      const fake = startFakeAuthServer('honest');
      const runId = newRunId();
      try {
        const first = await runK6Against(fake, { runId });
        expect(first.exitCode).toBe(0);
        // scripts/load.ts refills the IP bucket between runs; the fake mirrors it.
        fake.resetRateLimits();

        const retry = await runK6Against(fake, { runId });

        expect(failedChecks(retry)).toEqual([]);
        expect(retry.exitCode).toBe(0);
        expect(fake.poolReuses()).toBe(POOL_SIZE);
      } finally {
        await fake.stop();
      }
    },
    2 * K6_TIMEOUT_MS,
  );
});

// BUG-LOAD-RUN3-CRIT-01: the real server throttles sign-in per account (`signin:<name>`, 10
// attempts, then one per 30 s), and the fake models it. A retried run whose rate limits were not
// reset must still stay inside every name's budget. Only the IP buckets are refilled in between, so
// the second run starts with whatever the first one spent from each `signin:<name>` bucket.
describe('a same-RUN_ID smoke rerun against the per-account sign-in bucket', () => {
  test(
    'passes without a sign-in bucket reset in between: no pool name runs out of attempts',
    async () => {
      const fake = startFakeAuthServer('honest');
      const runId = newRunId();
      try {
        const first = await runK6Against(fake, { runId });
        expect(failedChecks(first)).toEqual([]);
        expect(first.exitCode).toBe(0);
        fake.resetIpRateLimits();

        const retry = await runK6Against(fake, { runId });

        expect(failedChecks(retry)).toEqual([]);
        expect(retry.exitCode).toBe(0);
        expect(fake.poolReuses()).toBe(POOL_SIZE);
      } finally {
        await fake.stop();
      }
    },
    2 * K6_TIMEOUT_MS,
  );
});
