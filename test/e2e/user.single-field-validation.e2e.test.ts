import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../src/shared/contracts/error.contract.ts';

import { type AuthServer, startAuthServer, STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-HIGH-02: every existing case broke both fields at once, so `||` -> `&&` in parseCredentials
// survived. Each case here breaks exactly one field and pins that only that field is reported.

let app: AuthServer;

beforeAll(async () => {
  app = await startAuthServer();
});

afterAll(async () => {
  await app.close();
});

const NAME_FORMAT = { field: 'name', message: 'Name must contain only letters and numbers, without spaces' };
const NAME_REQUIRED = { field: 'name', message: 'Name is required' };
const PASSWORD_WEAK = { field: 'password', message: 'Password is too weak' };
const PASSWORD_REQUIRED = { field: 'password', message: 'Password is required' };

const sharedCases = [
  ['an invalid name with a strong password', { name: 'has space', password: STRONG_PASSWORD }, NAME_FORMAT],
  ['a missing name with a strong password', { password: STRONG_PASSWORD }, NAME_REQUIRED],
  ['a valid name with a missing password', { name: 'validname' }, PASSWORD_REQUIRED],
] as const;
// Password strength is a sign-up rule only; sign-in compares the password with the stored hash.
const signUpOnlyCases = [
  ['a valid name with a weak password', { name: 'validname', password: 'password' }, PASSWORD_WEAK],
] as const;

describe.each([
  ['/api/auth/sign-up', [...sharedCases, ...signUpOnlyCases]],
  ['/api/auth/sign-in', sharedCases],
] as const)('POST %s with a single invalid field', (path, cases) => {
  test.each(cases)('rejects %s and reports only that field', async (_, body, fieldError) => {
    const response = await app.post(path, body);
    const payload: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      correlationId: expect.any(String),
      error: 'Bad Request',
      errors: [fieldError],
      message: 'Validation failed',
      path,
      statusCode: 400,
      timestamp: expect.any(String),
    });
  });
});

test('a sign-up rejected for a single field stores nothing', async () => {
  const name = app.freshName('single');

  const response = await app.post('/api/auth/sign-up', { name, password: 'password' });
  const [row] = await app.sql`SELECT count(*)::int AS count FROM users WHERE name = ${name}`;

  expect(response.status).toBe(400);
  expect(row.count).toBe(0);
});

test('POST /api/auth/sign-in with a weak password is a credential check (401), not a validation error', async () => {
  const response = await app.post('/api/auth/sign-in', { name: app.freshName('weak'), password: 'password' });

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: 'Unauthorized', message: 'Invalid credentials' });
});
