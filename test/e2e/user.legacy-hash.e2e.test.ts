import { afterAll, beforeAll, expect, test } from 'bun:test';

import type { AuthResponse } from '../../src/shared/contracts/auth.contract.ts';

import { type AuthServer, startAuthServer, STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// Users stored before the move to Bun.password have hashes from the `argon2` npm package. They
// must still sign in over HTTP, or the migration locks every existing account out.

/** `argon2` npm package (argon2id, m=65536, t=3, p=4) hash of STRONG_PASSWORD. */
const LEGACY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$3tBcNiOTIrGnUh/yDO5HpA$I+WCOWZBeH61gehtYcxvEzUStbw/afE0AXgQttE9lCg';

let app: AuthServer;
let name: string;

beforeAll(async () => {
  app = await startAuthServer();
  name = app.freshName('legacy');
  await app.sql`INSERT INTO users (name, password) VALUES (${name}, ${LEGACY_HASH})`;
});

afterAll(async () => {
  await app.close();
});

test('a user whose password was hashed by the argon2 package signs in with 200', async () => {
  const response = await app.post('/api/auth/sign-in', { name, password: STRONG_PASSWORD });
  const body: AuthResponse = await response.json();

  expect(response.status).toBe(200);
  expect(body.user.name).toBe(name);
  expect(body.token.split('.')).toHaveLength(3);
});

test('the same legacy user is rejected with 401 for a wrong password', async () => {
  const response = await app.post('/api/auth/sign-in', { name, password: 'another-Strong-pass-99' });

  expect(response.status).toBe(401);
});
