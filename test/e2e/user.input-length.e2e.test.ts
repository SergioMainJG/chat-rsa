import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../src/shared/contracts/error.contract.ts';

import { MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH } from '../../src/backend/user/domain/user.value-objects.ts';
import { type AuthServer, startAuthServer, STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-LOW-09: names and passwords had no upper bound, so a 500,000-character name was stored in
// the database and copied into every JWT. zxcvbn-ts only scores the first 256 characters, so a
// longer password would also be partly unchecked.

const ATTACK_LENGTH = 500_000;
const NAME_TOO_LONG = { field: 'name', message: `Name must be at most ${MAX_NAME_LENGTH} characters` };
const PASSWORD_TOO_LONG = { field: 'password', message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };

let app: AuthServer;

beforeAll(async () => {
  app = await startAuthServer();
});

afterAll(async () => {
  await app.close();
});

/** A unique alphanumeric name of exactly `length` characters. */
function nameOfLength(length: number): string {
  return app.freshName('n').padEnd(length, 'x').slice(0, length);
}

/** A strong password of exactly `length` characters. */
function passwordOfLength(length: number): string {
  return `${STRONG_PASSWORD}${'Zq8!'.repeat(length)}`.slice(0, length);
}

async function rows(name: string): Promise<number> {
  const [row] = await app.sql<Array<{ readonly count: number }>>`
    SELECT count(*)::int AS count FROM users WHERE name = ${name}
  `;
  return row?.count ?? 0;
}

describe('limits', () => {
  test('are 64 characters for a name and 256 for a password', () => {
    expect(MAX_NAME_LENGTH).toBe(64);
    expect(MAX_PASSWORD_LENGTH).toBe(256);
  });
});

describe('POST /api/auth/sign-up at the length boundaries', () => {
  test('accepts a name of exactly the maximum length', async () => {
    const name = nameOfLength(MAX_NAME_LENGTH);
    await app.sql`DELETE FROM users WHERE name = ${name}`;

    const response = await app.post('/api/auth/sign-up', { name, password: STRONG_PASSWORD });
    await app.sql`DELETE FROM users WHERE name = ${name}`;

    expect(response.status).toBe(201);
  });

  test('rejects a name one character over the maximum and stores nothing', async () => {
    const name = nameOfLength(MAX_NAME_LENGTH + 1);

    const response = await app.post('/api/auth/sign-up', { name, password: STRONG_PASSWORD });
    const payload: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errors).toEqual([NAME_TOO_LONG]);
    expect(await rows(name)).toBe(0);
  });

  test('accepts a password of exactly the maximum length', async () => {
    const name = app.freshName('pw');

    const response = await app.post('/api/auth/sign-up', { name, password: passwordOfLength(MAX_PASSWORD_LENGTH) });

    expect(response.status).toBe(201);
  });

  test('rejects a password one character over the maximum', async () => {
    const response = await app.post('/api/auth/sign-up', {
      name: app.freshName('pw'),
      password: passwordOfLength(MAX_PASSWORD_LENGTH + 1),
    });
    const payload: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(payload.errors).toEqual([PASSWORD_TOO_LONG]);
  });
});

describe.each(['/api/auth/sign-up', '/api/auth/sign-in'])(
  'POST %s with the reported 500,000-character payload',
  (path) => {
    test('rejects both oversized fields with 400 and stores nothing', async () => {
      const name = 'a'.repeat(ATTACK_LENGTH);

      const response = await app.post(path, { name, password: 'B'.repeat(ATTACK_LENGTH) });
      const payload: ErrorResponse = await response.json();

      expect(response.status).toBe(400);
      expect(payload.errors).toEqual([NAME_TOO_LONG, PASSWORD_TOO_LONG]);
      expect(await rows(name)).toBe(0);
    });
  },
);
