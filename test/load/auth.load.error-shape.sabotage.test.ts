import { describe, expect, test } from 'bun:test';

import { AppError } from '../../src/backend/shared/domain/app.error.ts';
import { errorResponse } from '../../src/backend/shared/http/http.error-response.ts';
import { STATUS_TEXT } from './support/error-format.ts';
import { type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// BUG-HIGH-07 (load run 2): `hasErrorShape` must check every field of the shared error format on
// its own (exact status title, message, path, timestamp, and the field errors of a 400), so a
// sabotage that breaks only one of them is still caught.

const ERROR_CHECKS = [
  'wrong password is 401',
  'invalid credentials are 400',
  'text/plain is 415',
  'unknown user is 401',
] as const;

class StatusProbeError extends AppError {
  constructor(readonly statusCode: number) {
    super('probe');
    this.name = 'StatusProbeError';
  }
}

async function runAgainst(sabotage: Sabotage): Promise<ProbeRun> {
  const fake = startFakeAuthServer(sabotage);
  try {
    return await runK6Against(fake);
  } finally {
    await fake.stop();
  }
}

describe('status titles used by the k6 suite', () => {
  test.each(Object.entries(STATUS_TEXT))('%s matches the server error format (%s)', async (code, title) => {
    const response = errorResponse(new Request('http://localhost/probe'), new StatusProbeError(Number(code)));
    const body: { error: string } = await response.json();
    expect(body.error).toBe(title);
  });

  test('covers every status the auth suite expects as an error', () => {
    for (const code of [400, 401, 409, 415, 429]) {
      expect(STATUS_TEXT[code]).toBeDefined();
    }
  });
});

describe('k6 auth suite against error bodies broken in one field', () => {
  test.each([
    ['error-generic-name', 'every error titled "Error"', ERROR_CHECKS],
    ['error-no-message', 'no message', ERROR_CHECKS],
    ['error-no-path', 'no path', ERROR_CHECKS],
    ['error-no-timestamp', 'no timestamp', ERROR_CHECKS],
    ['error-bad-timestamp', 'a timestamp that is not a date', ERROR_CHECKS],
    ['error-non-iso-timestamp', 'a date that is not ISO 8601 (RFC 1123)', ERROR_CHECKS],
    ['error-no-field-errors', 'a 400 without errors', ['invalid credentials are 400']],
    ['error-empty-field-errors', 'a 400 with errors: []', ['invalid credentials are 400']],
  ] as const)(
    'rejects %s (%s)',
    async (sabotage, _what, checks) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome).toSorted()).toEqual([...checks].toSorted());
    },
    K6_TIMEOUT_MS,
  );
});
