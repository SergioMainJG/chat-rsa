/** The `Set-Cookie` value of cookie `name` in a response, or null when it sets none. */
export function setCookieOf(response: Response, name: string): null | string {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`)) ?? null;
}

/** The JWT a sign-in, sign-up or refresh set in the `chat_rsa_session` cookie. */
export function sessionTokenOf(response: Response): string {
  const cookie = setCookieOf(response, 'chat_rsa_session');
  const token = cookie?.slice('chat_rsa_session='.length).split(';')[0] ?? '';
  if (token === '') {
    throw new Error(`No chat_rsa_session cookie (status ${response.status})`);
  }
  return token;
}
