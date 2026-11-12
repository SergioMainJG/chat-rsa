import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../src/shared/contracts/error.contract.ts';

import { MIN_PASSWORD_SCORE } from '../../src/backend/user/domain/user.value-objects.ts';
import { type AuthServer, startAuthServer } from '../support/auth-server.test-support.ts';

// BUG-HIGH-04: parseCredentials passes the name to zxcvbn as a user input, but no HTTP-level test
// proved it. Every password here is strong on its own, so only the name check can reject it.

const zxcvbn = new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });

let app: AuthServer;

beforeAll(async () => {
  app = await startAuthServer();
});

afterAll(async () => {
  await app.close();
});

const variants = [
  ['equals the name', (name: string) => name],
  ['is the name plus a symbol', (name: string) => `${name}!`],
  ['is the name in upper case', (name: string) => name.toUpperCase()],
] as const;

describe('POST /api/auth/sign-up with a password derived from the name', () => {
  const path = '/api/auth/sign-up';
  test.each(variants)('rejects a password that %s with 400 and a password field error', async (_, derive) => {
    const name = app.freshName('owner');
    const password = derive(name);
    expect(zxcvbn.check(password).score).toBeGreaterThanOrEqual(MIN_PASSWORD_SCORE);
    expect(zxcvbn.check(password, [name]).score).toBeLessThan(MIN_PASSWORD_SCORE);

    const response = await app.post(path, { name, password });
    const payload: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errors).toEqual([{ field: 'password', message: 'Password is too weak' }]);
    expect(payload.path).toBe(path);
  });
});

// Sign-in never judges strength, so a name-derived password goes straight to the credential check.
test.each(variants)('POST /api/auth/sign-in with a password that %s is a credential check (401)', async (_, derive) => {
  const name = app.freshName('owner');

  const response = await app.post('/api/auth/sign-in', { name, password: derive(name) });

  expect(response.status).toBe(401);
});

test('the same strong password is accepted for a user whose name it does not contain', async () => {
  const owner = app.freshName('owner');
  const other = app.freshName('other');

  const response = await app.post('/api/auth/sign-up', { name: other, password: owner });

  expect(response.status).toBe(201);
});
