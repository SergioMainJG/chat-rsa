import { describe, expect, test } from 'bun:test';

import { probeMessages } from './support/fake-messages-server.ts';
import { crossed, failedChecks, K6_TIMEOUT_MS, THRESHOLD_FAILED } from './support/k6-probe.test-support.ts';

// The real k6 messaging script against the real server and gateway, wired to in-memory adapters
// with the server's default rate-limit policies. The honest runs prove the wiring is faithful and
// the profiles fit the default buckets; messages.load.checks.sabotage.test.ts breaks each check.

/** Smoke runs 3 live iterations of 5 messages each; a stale-epoch send is never stored. */
const SMOKE_MESSAGES = 3 * 5;

describe('k6 messages suite against the honest server', () => {
  test(
    'smoke passes, runs every check, and stores each idempotent message once',
    async () => {
      const outcome = await probeMessages('honest');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      const checks = Object.entries(outcome.summary?.root_group.checks ?? {});
      // Every check of rest() and live() ran; only the stress burst's checks are absent.
      expect(checks).toHaveLength(35);
      expect(checks.filter(([, result]) => result.passes === 0)).toEqual([]);
      expect(outcome.summary?.root_group.checks['send is acked with the stored message']).toMatchObject({
        fails: 0,
        passes: SMOKE_MESSAGES,
      });
      expect(outcome.storedMessages).toBe(SMOKE_MESSAGES);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'stress fits the default buckets, then bursts past the user bucket with well-formed 429s',
    async () => {
      const outcome = await probeMessages('honest', 'stress');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      expect(crossed(outcome, 'http_req_failed')).toBe(false);
      expect(outcome.summary?.metrics.rate_limited?.count ?? 0).toBeGreaterThan(0);
      for (const name of ['429 carries an integer Retry-After of at least 1', '429 has the shared error shape']) {
        expect(outcome.summary?.root_group.checks[name]?.passes ?? 0).toBeGreaterThan(0);
      }
    },
    K6_TIMEOUT_MS,
  );
});

describe('k6 messages stress burst against sabotaged servers', () => {
  test(
    'catches no-rate-limit: a stress burst that never gets 429',
    async () => {
      const outcome = await probeMessages('no-rate-limit', 'stress');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'rate_limited')).toBe(true);
      expect(failedChecks(outcome)).toEqual(['a burst past the user bucket gets 429']);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'catches no-retry-after: a 429 without Retry-After',
    async () => {
      const outcome = await probeMessages('no-retry-after', 'stress');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toEqual(['429 carries an integer Retry-After of at least 1']);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'catches burst-503: part of the burst answers 503 instead of 429',
    async () => {
      const outcome = await probeMessages('burst-503', 'stress');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toEqual(['a burst is answered only with 200 or 429']);
      expect(crossed(outcome, 'http_req_failed')).toBe(true);
    },
    K6_TIMEOUT_MS,
  );
});
