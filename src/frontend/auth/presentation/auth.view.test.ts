import { describe, expect, test } from 'bun:test';

import { credentialsFrom, outcomeOf } from './auth.view.ts';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

const session = { token: 'header.payload.signature', user: { id: 7, name: 'alice' } };

describe('credentialsFrom', () => {
  test('reads name and password from the form', () => {
    expect(credentialsFrom(form({ name: 'alice', password: 'pw' }))).toEqual({ name: 'alice', password: 'pw' });
  });

  test('uses empty strings for missing fields, so the server reports them as required', () => {
    expect(credentialsFrom(new FormData())).toEqual({ name: '', password: '' });
  });

  test('ignores fields other than name and password', () => {
    expect(credentialsFrom(form({ extra: 'x', name: 'a', password: 'b' }))).toEqual({ name: 'a', password: 'b' });
  });
});

describe('outcomeOf', () => {
  test('a 2xx {user, token} body is a success with the session', async () => {
    expect(await outcomeOf(Response.json(session, { status: 201 }))).toEqual({ kind: 'success', session });
  });

  test('field errors are grouped by field, with the server message as the form message', async () => {
    const response = Response.json(
      {
        correlationId: 'c',
        error: 'Bad Request',
        errors: [
          { field: 'name', message: 'Name is required' },
          { field: 'password', message: 'Password is too weak' },
        ],
        message: 'Validation failed',
        path: '/api/auth/sign-up',
        statusCode: 400,
        timestamp: '2026-11-12T00:00:00.000Z',
      },
      { status: 400 },
    );

    expect(await outcomeOf(response)).toEqual({
      fieldErrors: { name: 'Name is required', password: 'Password is too weak' },
      kind: 'failure',
      message: 'Validation failed',
    });
  });

  test('an error without field errors keeps only the message', async () => {
    const response = Response.json(
      { error: 'Unauthorized', message: 'Invalid credentials', statusCode: 401 },
      { status: 401 },
    );

    expect(await outcomeOf(response)).toEqual({ fieldErrors: {}, kind: 'failure', message: 'Invalid credentials' });
  });

  test.each([
    ['a non-JSON error body', new Response('<html>bad gateway</html>', { status: 502 })],
    ['a 2xx body without a token', Response.json({ user: { id: 1, name: 'a' } }, { status: 200 })],
  ])('falls back to a generic message for %s', async (_, response) => {
    expect(await outcomeOf(response)).toEqual({
      fieldErrors: {},
      kind: 'failure',
      message: 'Something went wrong. Please try again.',
    });
  });
});
