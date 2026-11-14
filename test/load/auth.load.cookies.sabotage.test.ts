import { describe, expect, test } from 'bun:test';

import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// BUG-LOAD-RUN3-HIGH-02 (auth part): every attribute of both session cookies is checked, and each
// sabotage below breaks exactly one of them, so each attribute check is proven on its own. The
// attribute checks live inside the sign-in and sign-up checks (`hasSessionCookies`).

const AUTH_CHECKS = [
  'sign-in returns {user} and the session cookies',
  'sign-up returns {user} and the session cookies',
];

async function runAgainst(sabotage: Sabotage): Promise<ProbeRun> {
  const fake = startFakeAuthServer(sabotage);
  try {
    return await runK6Against(fake);
  } finally {
    await fake.stop();
  }
}

describe('k6 auth suite against session cookies broken in one attribute', () => {
  test.each([
    ['session-cookie-not-secure', 'a session cookie without Secure'],
    ['session-cookie-wrong-max-age', 'a session cookie that outlives the token'],
    ['hint-cookie-httponly', 'a hint cookie the route guard cannot read (HttpOnly)'],
    ['hint-cookie-not-secure', 'a hint cookie without Secure'],
    ['hint-cookie-wrong-max-age', 'a hint cookie that outlives the token'],
    ['cookie-samesite-lax', 'cookies with SameSite=Lax instead of Strict'],
    ['cookie-path-not-root', 'cookies scoped to Path=/api instead of /'],
  ] as const)(
    'rejects %s (%s)',
    async (sabotage) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      for (const name of AUTH_CHECKS) {
        expect(failedChecks(outcome)).toContain(name);
      }
    },
    K6_TIMEOUT_MS,
  );
});
