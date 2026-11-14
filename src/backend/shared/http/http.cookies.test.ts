import { describe, expect, test } from 'bun:test';

import { clearedSessionCookies, cookieOf, sessionCookies, withCookies } from './http.cookies.ts';

function withCookie(header?: string): Request {
  return new Request('http://localhost/', { headers: header === undefined ? {} : { cookie: header } });
}

describe('cookieOf', () => {
  test.each([
    [undefined, null],
    ['', null],
    ['other=1', null],
    ['chat_rsa_session=', null],
    ['chat_rsa_session=abc.def.ghi', 'abc.def.ghi'],
    ['a=1; chat_rsa_session=abc; b=2', 'abc'],
  ])('reads %p as %p', (header, expected) => {
    expect(cookieOf(withCookie(header), 'chat_rsa_session')).toBe(expected);
  });
});

describe('session cookies', () => {
  test('sets the HttpOnly token and the readable exp hint, both Secure and SameSite=Strict', () => {
    const expiresAt = new Date(1_800_000_000_000);
    expect(sessionCookies({ expiresAt, token: 'a.b.c' }, 3600)).toEqual([
      'chat_rsa_session=a.b.c; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600',
      'chat_rsa_session_hint=1800000000; Secure; SameSite=Strict; Path=/; Max-Age=3600',
    ]);
  });

  test('clears both with Max-Age=0', () => {
    expect(clearedSessionCookies()).toEqual([
      'chat_rsa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      'chat_rsa_session_hint=; Secure; SameSite=Strict; Path=/; Max-Age=0',
    ]);
  });

  test('withCookies adds one Set-Cookie header per cookie', () => {
    const response = withCookies(new Response(null, { status: 204 }), ['a=1', 'b=2']);
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});
