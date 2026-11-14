import { describe, expect, test } from 'bun:test';

import { guardRoute } from './auth.guard.ts';

const NOW_MS = Date.UTC(2026, 10, 13, 12);

function tokenWith(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

const LIVE = tokenWith({ exp: NOW_MS / 1000 + 60, sub: '7' });
const EXPIRED = tokenWith({ exp: NOW_MS / 1000 - 1, sub: '7' });

describe('guardRoute', () => {
  test('a members-only page lets a live session in', () => {
    expect(guardRoute('members', LIVE, NOW_MS)).toEqual({ kind: 'allow' });
  });

  test.each([
    ['no token', null],
    ['an expired token', EXPIRED],
    ['a malformed token', 'not-a-jwt'],
  ])('a members-only page sends %s to /sign-in', (_case, token) => {
    expect(guardRoute('members', token, NOW_MS)).toEqual({ kind: 'redirect', path: '/sign-in' });
  });

  test('a guests-only page sends a live session to /chat', () => {
    expect(guardRoute('guests', LIVE, NOW_MS)).toEqual({ kind: 'redirect', path: '/chat' });
  });

  test.each([
    ['no token', null],
    ['an expired token', EXPIRED],
  ])('a guests-only page lets %s in', (_case, token) => {
    expect(guardRoute('guests', token, NOW_MS)).toEqual({ kind: 'allow' });
  });
});
