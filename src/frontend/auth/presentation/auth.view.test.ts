import { describe, expect, test } from 'bun:test';

import { setLocaleFromLang } from '../../i18n/i18n.messages.ts';
import { credentialsFrom, hasLiveSession, outcomeOf } from './auth.view.ts';

const NOW_MS = 1_800_000_000_000;

describe('hasLiveSession (from the chat_rsa_session_hint cookie: exp in epoch seconds)', () => {
  test('a hint whose exp is in the future is a live session', () => {
    expect(hasLiveSession(String(NOW_MS / 1000 + 60), NOW_MS)).toBe(true);
  });

  test('an expired hint is not a live session', () => {
    expect(hasLiveSession(String(NOW_MS / 1000 - 1), NOW_MS)).toBe(false);
  });

  test('no hint is not a live session', () => {
    expect(hasLiveSession(null, NOW_MS)).toBe(false);
  });

  test('a hint that is not a whole number of seconds is not a live session', () => {
    for (const hint of ['', 'soon', '1e12', '1800000060.5', '-1', 'header.payload.signature']) {
      expect(hasLiveSession(hint, NOW_MS)).toBe(false);
    }
  });
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

const session = { user: { id: 7, name: 'alice' } };

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
  test('a 2xx {user} body (the token is only in the cookie) is a success with the session that goes to the chat room', async () => {
    expect(await outcomeOf(Response.json(session, { status: 201 }))).toEqual({
      kind: 'success',
      redirectTo: '/en/chat',
      session,
    });
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
    ['a 2xx body without a user', Response.json({ token: 'a.b.c' }, { status: 200 })],
  ])('falls back to a generic message for %s', async (_, response) => {
    expect(await outcomeOf(response)).toEqual({
      fieldErrors: {},
      kind: 'failure',
      message: 'Something went wrong. Please try again.',
    });
  });
});

test('on a Spanish page the server message and field errors are translated', async () => {
  setLocaleFromLang('es');
  try {
    const response = Response.json(
      {
        error: 'Bad Request',
        errors: [{ field: 'name', message: 'Name is required' }],
        message: 'Validation failed',
        statusCode: 400,
      },
      { status: 400 },
    );
    expect(await outcomeOf(response)).toEqual({
      fieldErrors: { name: 'El nombre es obligatorio.' },
      kind: 'failure',
      message: 'Revisa los campos marcados.',
    });
  } finally {
    setLocaleFromLang('en');
  }
});
