import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type AuthServer, startAuthServer, STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-LOW-08: the controller parsed any body as JSON. `text/plain`, form-encoded and multipart
// bodies are CORS "simple requests" that a foreign page can send without a preflight, so the
// auth routes must only accept `application/json`.

let app: AuthServer;

beforeAll(async () => {
  app = await startAuthServer();
});

afterAll(async () => {
  await app.close();
});

const PATHS = ['/api/auth/sign-up', '/api/auth/sign-in'] as const;
const SIMPLE_REQUEST_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'] as const;

function unsupported(path: string): Record<string, unknown> {
  return {
    correlationId: expect.any(String),
    error: 'Unsupported Media Type',
    message: 'Content-Type must be application/json',
    path,
    statusCode: 415,
    timestamp: expect.any(String),
  };
}

describe.each(PATHS)('POST %s', (path) => {
  test.each(SIMPLE_REQUEST_TYPES)('rejects a valid JSON body sent as %s with 415', async (contentType) => {
    const name = app.freshName('ctype');

    const response = await app.post(path, { name, password: STRONG_PASSWORD }, contentType);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual(unsupported(path));
  });

  test('rejects a body without a Content-Type header with 415', async () => {
    // A Blob without a type, so fetch does not add a default `text/plain` header on its own.
    const body = new Blob([JSON.stringify({ name: app.freshName('ctype'), password: STRONG_PASSWORD })]);

    const response = await app.post(path, body, null);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual(unsupported(path));
  });

  test('accepts application/json with a charset parameter, in any letter case', async () => {
    const response = await app.post(
      path,
      { name: 'has space', password: STRONG_PASSWORD },
      'Application/JSON; charset=utf-8',
    );

    // Reaches validation, so the media type was accepted.
    expect(response.status).toBe(400);
  });
});

test('a sign-up rejected for its media type stores nothing', async () => {
  const name = app.freshName('ctype');

  await app.post('/api/auth/sign-up', { name, password: STRONG_PASSWORD }, 'text/plain');
  const [row] = await app.sql`SELECT count(*)::int AS count FROM users WHERE name = ${name}`;

  expect(row.count).toBe(0);
});
