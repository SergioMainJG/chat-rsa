/**
 * Body of sign-in, sign-up and refresh. The JWT is never in a body: it travels in the HttpOnly
 * `chat_rsa_session` cookie, and its expiry in the readable `chat_rsa_session_hint` cookie.
 */
export type AuthResponse = {
  readonly user: PublicUser;
};

export type Credentials = {
  readonly name: string;
  readonly password: string;
};

export type PublicUser = {
  readonly id: number;
  readonly name: string;
};

export const SESSION_COOKIE = 'chat_rsa_session';
export const SESSION_HINT_COOKIE = 'chat_rsa_session_hint';
