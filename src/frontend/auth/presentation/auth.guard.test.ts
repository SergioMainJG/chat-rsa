import { describe, expect, test } from 'bun:test';

import { guardRoute, sessionHintOf } from './auth.guard.ts';

const NOW_MS = Date.UTC(2026, 10, 13, 12);

const LIVE = String(NOW_MS / 1000 + 60);
const EXPIRED = String(NOW_MS / 1000 - 1);

describe('guardRoute (reads the chat_rsa_session_hint cookie, never the token)', () => {
  test('a members-only page lets a live session in', () => {
    expect(guardRoute('members', LIVE, NOW_MS)).toEqual({ kind: 'allow' });
  });

  test.each([
    ['no hint', null],
    ['an expired hint', EXPIRED],
    ['a malformed hint', 'not-a-number'],
    ['a JWT instead of a number', 'a.b.c'],
  ])('a members-only page sends %s to /sign-in', (_case, hint) => {
    expect(guardRoute('members', hint, NOW_MS)).toEqual({ kind: 'redirect', path: '/sign-in' });
  });

  test('a guests-only page sends a live session to /chat', () => {
    expect(guardRoute('guests', LIVE, NOW_MS)).toEqual({ kind: 'redirect', path: '/chat' });
  });

  test.each([
    ['no hint', null],
    ['an expired hint', EXPIRED],
  ])('a guests-only page lets %s in', (_case, hint) => {
    expect(guardRoute('guests', hint, NOW_MS)).toEqual({ kind: 'allow' });
  });
});

describe('sessionHintOf', () => {
  test.each([
    ['', null],
    ['other=1', null],
    ['chat_rsa_session_hint=1800000000', '1800000000'],
    ['a=1; chat_rsa_session_hint=1800000000; b=2', '1800000000'],
    ['chat_rsa_session_hint=', null],
  ])('reads document.cookie %p as %p', (cookies, expected) => {
    expect(sessionHintOf(cookies)).toBe(expected);
  });
});
