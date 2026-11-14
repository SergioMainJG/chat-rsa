import { SESSION_COOKIE, SESSION_HINT_COOKIE } from '../../../shared/contracts/auth.contract.ts';

export { SESSION_COOKIE, SESSION_HINT_COOKIE } from '../../../shared/contracts/auth.contract.ts';

// `chat_rsa_session` is the credential (HttpOnly). `chat_rsa_session_hint` is not a credential:
// the token's `exp` in epoch seconds, readable by JS for the frontend route guard only; the server
// never authenticates with it.

const ATTRIBUTES = 'Secure; SameSite=Strict; Path=/';

/** The value of cookie `name` in the request's `Cookie` header, or null. */
export function cookieOf(request: Request, name: string): null | string {
  const header = request.headers.get('cookie');
  if (header === null) {
    return null;
  }
  const value = new Bun.CookieMap(header).get(name);
  return value === null || value === '' ? null : value;
}

/** The two `Set-Cookie` values of a signed-in session: the HttpOnly token and its expiry hint. */
export function sessionCookies(
  session: { readonly expiresAt: Date; readonly token: string },
  maxAgeSeconds: number,
): readonly string[] {
  const exp = Math.floor(session.expiresAt.getTime() / 1000);
  return [
    `${SESSION_COOKIE}=${session.token}; HttpOnly; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`,
    `${SESSION_HINT_COOKIE}=${exp}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`,
  ];
}

/** Both session cookies, expired now. */
export function clearedSessionCookies(): readonly string[] {
  return [
    `${SESSION_COOKIE}=; HttpOnly; ${ATTRIBUTES}; Max-Age=0`,
    `${SESSION_HINT_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`,
  ];
}

/** Adds one `Set-Cookie` header per cookie to the response. */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
