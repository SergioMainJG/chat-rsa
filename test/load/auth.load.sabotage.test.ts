import { describe, expect, test } from 'bun:test';

import type { Profile } from './k6-runner.ts';

import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  crossed,
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  SCRIPT_EXCEPTION,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// Each case runs the real k6 script against a fake server with one deliberate defect from
// bugs/load.bug.md and asserts that the suite reports it. The `honest` case proves the fake is
// faithful: the same script passes against it.

type Outcome = ProbeRun & { readonly unknownSignIns: number };

async function runAgainst(sabotage: Sabotage, profile: Profile = 'smoke'): Promise<Outcome> {
  const fake = startFakeAuthServer(sabotage);
  try {
    const run = await runK6Against(fake, { profile });
    return { ...run, unknownSignIns: fake.unknownSignIns() };
  } finally {
    await fake.stop();
  }
}

describe('k6 auth suite against sabotaged servers', () => {
  test(
    'passes against the honest fake, which also receives unknown-user sign-ins (L-05)',
    async () => {
      const outcome = await runAgainst('honest');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      expect(outcome.unknownSignIns).toBeGreaterThan(0);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'L-01: valid sign-ins answered with 401 count as failed requests',
    async () => {
      const outcome = await runAgainst('sign-in-401');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'http_req_failed')).toBe(true);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'L-02: a sign-in pool left by an aborted run is reused instead of crashing setup()',
    async () => {
      const outcome = await runAgainst('pool-exists');

      expect(outcome.exitCode).not.toBe(SCRIPT_EXCEPTION);
      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
    },
    K6_TIMEOUT_MS,
  );

  test.each([
    ['no-user-id', 'a response without user.id'],
    ['garbage-token', 'a token that is not a JWT'],
    ['text-content-type', 'a success body served as text/plain'],
  ] as const)(
    'L-03: rejects %s (%s)',
    async (sabotage) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      for (const name of ['sign-in returns {user, token}', 'sign-up returns {user, token}']) {
        expect(failedChecks(outcome)).toContain(name);
      }
    },
    K6_TIMEOUT_MS,
  );

  test(
    'L-04: rejects error bodies stripped of error, message, path and timestamp',
    async () => {
      const outcome = await runAgainst('stripped-errors');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      for (const name of ['wrong password is 401', 'invalid credentials are 400', 'text/plain is 415']) {
        expect(failedChecks(outcome)).toContain(name);
      }
    },
    K6_TIMEOUT_MS,
  );

  test(
    'L-05: an unknown name that signs in successfully is caught',
    async () => {
      const outcome = await runAgainst('unknown-user-accepted');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toContain('unknown user is 401');
    },
    K6_TIMEOUT_MS,
  );
});
