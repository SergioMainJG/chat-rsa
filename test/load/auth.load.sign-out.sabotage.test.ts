import { describe, expect, test } from 'bun:test';

import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// BUG-LOAD-RUN3-CRIT-04 (auth part): the suite signs out over HTTP (204, both cookies cleared, the
// old token refused by refresh and by a protected GET) and checks the CSRF origin guard (a foreign
// Origin and a cookie request without Origin are refused with 403; a bearer request without Origin
// passes). Each sabotage breaks one of those behaviors and must fail exactly its check.

const LIVE = 'a live session reads GET /api/rooms';
const FOREIGN_ORIGIN = 'a foreign Origin is refused with 403';
const COOKIE_WITHOUT_ORIGIN = 'a cookie-authenticated refresh without Origin is 403';
const BEARER_WITHOUT_ORIGIN = 'a bearer refresh without Origin is 200';
const SIGN_OUT = 'sign-out is 204 and clears both session cookies';
const REFRESH_AFTER = 'a signed-out token is refused by refresh';
const ROOMS_AFTER = 'a signed-out token is refused by GET /api/rooms';

function ranChecks(run: ProbeRun): string[] {
  return Object.keys(run.summary?.root_group.checks ?? {});
}

async function runAgainst(sabotage: Sabotage): Promise<ProbeRun> {
  const fake = startFakeAuthServer(sabotage);
  try {
    return await runK6Against(fake);
  } finally {
    await fake.stop();
  }
}

describe('k6 auth suite: sign-out and the CSRF origin guard', () => {
  test(
    'runs every sign-out and origin check, and passes against the honest fake',
    async () => {
      const outcome = await runAgainst('honest');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      for (const name of [
        LIVE,
        FOREIGN_ORIGIN,
        COOKIE_WITHOUT_ORIGIN,
        BEARER_WITHOUT_ORIGIN,
        SIGN_OUT,
        REFRESH_AFTER,
        ROOMS_AFTER,
      ]) {
        expect(ranChecks(outcome)).toContain(name);
      }
    },
    K6_TIMEOUT_MS,
  );

  test.each([
    ['sign-out-keeps-cookies', 'a sign-out that leaves both cookies in place', [SIGN_OUT]],
    ['refresh-ignores-revocation', 'a refresh that still accepts a signed-out token', [REFRESH_AFTER]],
    ['rooms-ignores-revocation', 'a protected GET that still accepts a signed-out token', [ROOMS_AFTER]],
    ['origin-untrusted-allowed', 'an unsafe request from a foreign Origin let through', [FOREIGN_ORIGIN]],
    [
      'origin-cookie-without-origin-allowed',
      'a cookie-authenticated unsafe request without Origin let through',
      [COOKIE_WITHOUT_ORIGIN],
    ],
  ] as const)(
    'rejects %s (%s), failing exactly its check',
    async (sabotage, _what, checks) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome).toSorted()).toEqual([...checks].toSorted());
    },
    K6_TIMEOUT_MS,
  );

  test(
    'rejects origin-bearer-without-origin-refused (a bearer client without Origin refused with 403)',
    async () => {
      const outcome = await runAgainst('origin-bearer-without-origin-refused');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      // The sign-out is a bearer request without Origin too, so the later checks fail with it.
      expect(failedChecks(outcome)).toContain(BEARER_WITHOUT_ORIGIN);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'a token no endpoint accepts fails the live-session check',
    async () => {
      const outcome = await runAgainst('garbage-token');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toContain(LIVE);
    },
    K6_TIMEOUT_MS,
  );
});
