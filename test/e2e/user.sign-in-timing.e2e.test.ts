import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../src/shared/contracts/error.contract.ts';

import { type AuthServer, startAuthServer, STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-MEDIUM-05: no test ever signed in as an unknown user through the real Argon2 hasher, so
// removing the dummy verify for `hash === null` survived. Without it, an unknown name answers in
// microseconds while a known one pays a full argon2 verify, which leaks which names exist.

const SAMPLES = 5;
// Generous on purpose: the real paths are within a few percent, the leaking mutant is ~50x faster.
const MIN_LATENCY_RATIO = 0.5;
const WRONG_PASSWORD = 'another-Strong-pass-99';

let app: AuthServer;
let knownName: string;

beforeAll(async () => {
  app = await startAuthServer();
  knownName = app.freshName('known');
  const signUp = await app.post('/api/auth/sign-up', { name: knownName, password: STRONG_PASSWORD });
  expect(signUp.status).toBe(201);
});

afterAll(async () => {
  await app.close();
});

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function medianLatency(name: () => string): Promise<number> {
  const timings: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    // Sequential on purpose: concurrent requests would measure contention, not the code path.
    // eslint-disable-next-line no-await-in-loop -- each sample must not overlap the previous one
    const { ms } = await signIn(name());
    timings.push(ms);
  }
  return median(timings);
}

async function signIn(
  name: string,
): Promise<{ readonly body: ErrorResponse; readonly ms: number; readonly status: number }> {
  const started = performance.now();
  const response = await app.post('/api/auth/sign-in', { name, password: WRONG_PASSWORD });
  const body: ErrorResponse = await response.json();
  return { body, ms: performance.now() - started, status: response.status };
}

describe('POST /api/auth/sign-in for an unknown name', () => {
  test('answers exactly like a wrong password for an existing user', async () => {
    const unknown = await signIn(app.freshName('ghost'));
    const wrong = await signIn(knownName);

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const { correlationId: _u, timestamp: _ut, ...unknownBody } = unknown.body;
    const { correlationId: _w, timestamp: _wt, ...wrongBody } = wrong.body;
    expect(unknownBody).toEqual(wrongBody);
    expect(unknownBody).toEqual({
      error: 'Unauthorized',
      message: 'Invalid credentials',
      path: '/api/auth/sign-in',
      statusCode: 401,
    });
  });

  test('takes comparable time to a wrong password, so names cannot be enumerated by latency', async () => {
    // Warm both paths: the first unknown sign-in also computes the dummy hash once.
    await signIn(app.freshName('ghost'));
    await signIn(knownName);

    const wrongPassword = await medianLatency(() => knownName);
    const unknownName = await medianLatency(() => app.freshName('ghost'));

    expect(unknownName).toBeGreaterThanOrEqual(wrongPassword * MIN_LATENCY_RATIO);
    // 12 sequential argon2 sign-ins at ~140 ms each (Bun.password, p=1) are close to Bun's 5 s default.
  }, 30_000);
});
