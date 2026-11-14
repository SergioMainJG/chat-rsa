import { RedisClient } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';

import { composeApp } from '../../src/backend/app.composition.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { User } from '../../src/backend/user/domain/user.entity.ts';
import { PasswordHash, UserId, UserName } from '../../src/backend/user/domain/user.value-objects.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import {
  type ServerFrame,
  SOCKET_PATH,
  SOCKET_PROTOCOL,
} from '../../src/shared/contracts/messaging.socket.contract.ts';
import { bunWebSocket } from '../support/bun-websocket.test-support.ts';
import { sessionTokenOf, setCookieOf } from '../support/session-cookie.test-support.ts';

// S3, S4 and S7 over the real server: the HttpOnly session cookie, its hint, CSRF origin checks,
// the absolute session lifetime and the per-account sign-in throttle.

const PASSWORD = 'correct-Horse-battery-st4ple';
const SECRET = 'e2e-session-cookie-secret';
const ORIGIN = 'http://localhost:3000';
const MAX_AGE_SECONDS = 604_800;
const SIGNIN_CAPACITY = 3;
const config = loadConfig();
const sql = createPostgresClient({ max: 4, url: config.databaseUrl });
const cache = new RedisClient(config.cacheUrl);
const createdUsers: string[] = [];
const sockets: WebSocket[] = [];
let server: ReturnType<typeof createServer>;

const CLEARED = [
  'chat_rsa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
  'chat_rsa_session_hint=; Secure; SameSite=Strict; Path=/; Max-Age=0',
];

beforeAll(async () => {
  await applyUserSchema(sql);
  const { auth, messaging } = composeApp({
    cache,
    config: {
      ...config,
      appOrigins: [ORIGIN],
      jwtSecret: SECRET,
      rateLimit: { ...config.rateLimit, signin: { capacity: SIGNIN_CAPACITY, refillPerSecond: 1 / 30 } },
      sessionMaxAgeSeconds: MAX_AGE_SECONDS,
    },
    hasher: new Argon2PasswordHasher(),
    logger: { error: (error) => console.error(error) },
    sql,
    tokens: new JoseTokenIssuer(SECRET),
  });
  server = createServer({ auth, messaging, port: 0 });
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.close();
  }
  await server.stop(true);
  if (createdUsers.length > 0) {
    await sql`DELETE FROM users WHERE name IN ${sql(createdUsers)}`;
  }
  await sql.close();
  cache.close();
});

type Frames = { readonly next: (type: ServerFrame['type']) => Promise<ServerFrame> };

async function call(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    headers: { ...(init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
    method: init.method ?? 'GET',
  });
}

/** The status of a plain `/ws` upgrade request (no real socket), for refused upgrades. */
function cookie(token: string): Record<string, string> {
  return { cookie: `chat_rsa_session=${token}` };
}

function freshName(prefix: string): string {
  const name = `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  createdUsers.push(name);
  return name;
}

async function signUp(prefix: string): Promise<{ id: number; name: string; token: string }> {
  const name = freshName(prefix);
  const response = await call('/api/auth/sign-up', { body: { name, password: PASSWORD }, method: 'POST' });
  const body: { user: { id: number } } = await response.json();
  return { id: body.user.id, name, token: sessionTokenOf(response) };
}

async function upgrade(headers: Record<string, string>): Promise<number> {
  const response = await fetch(new URL(SOCKET_PATH, server.url), {
    headers: { connection: 'Upgrade', 'sec-websocket-protocol': SOCKET_PROTOCOL, upgrade: 'websocket', ...headers },
  });
  return response.status;
}

/** Opens `/ws` like a browser: only `chat-rsa.v1`, the session cookie and the page's Origin. */
async function browserSocket(
  token: string,
  origin: null | string = ORIGIN,
): Promise<{ closed: Promise<number>; frames: Frames }> {
  const socket = bunWebSocket(new URL(SOCKET_PATH, server.url.href.replace(/^http/u, 'ws')).href, {
    headers: { ...cookie(token), ...(origin !== null && { origin }) },
    protocols: [SOCKET_PROTOCOL],
  });
  sockets.push(socket);
  const buffered: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const frame: ServerFrame = JSON.parse(String(event.data));
    buffered.push(frame);
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  const next = async (type: ServerFrame['type']): Promise<ServerFrame> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = buffered.findIndex((frame) => frame.type === type);
      const [found] = index === -1 ? [] : buffered.splice(index, 1);
      if (found) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${type} frame within 5 s`);
      }
      // eslint-disable-next-line no-await-in-loop -- polls the buffered frames
      await Bun.sleep(20);
    }
  };
  return { closed, frames: { next } };
}

describe('the session lives in an HttpOnly cookie (S4)', () => {
  test('sign-in answers {user} only and sets the token cookie and its readable exp hint', async () => {
    const { name } = await signUp('ckin');

    const response = await call('/api/auth/sign-in', { body: { name, password: PASSWORD }, method: 'POST' });
    const token = sessionTokenOf(response);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: expect.any(Number), name } });
    expect(setCookieOf(response, 'chat_rsa_session')).toBe(
      `chat_rsa_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
    );
    expect(setCookieOf(response, 'chat_rsa_session_hint')).toBe(
      `chat_rsa_session_hint=${decodeJwt(token).exp}; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
    );
  });

  test('REST authenticates the cookie; the hint cookie alone is not a credential', async () => {
    const alice = await signUp('ckrest');

    const withCookie = await call('/api/rooms', { headers: cookie(alice.token) });
    const withHint = await call('/api/rooms', {
      headers: { cookie: `chat_rsa_session_hint=${decodeJwt(alice.token).exp}` },
    });
    const withBearer = await call('/api/rooms', { headers: { authorization: `Bearer ${alice.token}` } });

    expect(withCookie.status).toBe(200);
    expect(withHint.status).toBe(401);
    expect(withBearer.status).toBe(200);
  });

  test('CSRF: a cookie POST needs an allowed Origin; a foreign Origin is refused even with a bearer token', async () => {
    const alice = await signUp('ckcsrf');
    const bob = await signUp('ckcsrfb');
    const body = { memberIds: [bob.id], name: 'csrf' };

    const noOrigin = await call('/api/rooms', { body, headers: cookie(alice.token), method: 'POST' });
    const foreign = await call('/api/rooms', {
      body,
      headers: { ...cookie(alice.token), origin: 'https://evil.example' },
      method: 'POST',
    });
    const foreignBearer = await call('/api/rooms', {
      body,
      headers: { authorization: `Bearer ${alice.token}`, origin: 'https://evil.example' },
      method: 'POST',
    });
    const foreignSignIn = await call('/api/auth/sign-in', {
      body: { name: alice.name, password: PASSWORD },
      headers: { origin: 'https://evil.example' },
      method: 'POST',
    });

    expect([noOrigin.status, foreign.status, foreignBearer.status, foreignSignIn.status]).toEqual([403, 403, 403, 403]);
    expect(await noOrigin.json()).toMatchObject({ message: 'Origin not allowed', statusCode: 403 });
    const [count] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM room_members WHERE user_id = ${alice.id}`;
    expect(count?.n).toBe(0);

    const allowed = await call('/api/rooms', {
      body,
      headers: { ...cookie(alice.token), origin: ORIGIN },
      method: 'POST',
    });
    expect(allowed.status).toBe(201);
    const room: { id: string } = await allowed.json();
    await sql`DELETE FROM rooms WHERE id = ${room.id}`;
  });

  test('a browser socket authenticates with the cookie from an allowed Origin, and only from one', async () => {
    const alice = await signUp('ckws');

    const opened = await browserSocket(alice.token);
    expect(await opened.frames.next('ready')).toMatchObject({ type: 'ready', userId: alice.id });

    expect(await upgrade(cookie(alice.token))).toBe(403);
    expect(await upgrade({ ...cookie(alice.token), origin: 'https://evil.example' })).toBe(403);
  });

  test('refresh by cookie answers {user}, sets fresh cookies and pushes auth.refreshed to the session sockets', async () => {
    const alice = await signUp('ckref');
    const socket = await browserSocket(alice.token);
    await socket.frames.next('ready');

    const response = await call('/api/auth/refresh', {
      headers: { ...cookie(alice.token), origin: ORIGIN },
      method: 'POST',
    });
    const fresh = sessionTokenOf(response);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: alice.id, name: alice.name } });
    expect(setCookieOf(response, 'chat_rsa_session_hint')).toContain(`chat_rsa_session_hint=${decodeJwt(fresh).exp};`);
    const pushed = await socket.frames.next('auth.refreshed');
    expect(pushed).toEqual({
      expiresAt: new Date((decodeJwt(fresh).exp ?? 0) * 1000).toISOString(),
      type: 'auth.refreshed',
    });
    expect(decodeJwt(fresh).sid).toBe(decodeJwt(alice.token).sid);
    expect(decodeJwt(fresh).sst).toBe(decodeJwt(alice.token).sst);

    const noOrigin = await call('/api/auth/refresh', { headers: cookie(alice.token), method: 'POST' });
    expect(noOrigin.status).toBe(403);
  });

  test('sign-out by cookie answers 204, clears both cookies, closes the session sockets and ends the session', async () => {
    const alice = await signUp('ckout');
    const socket = await browserSocket(alice.token);
    await socket.frames.next('ready');

    const response = await call('/api/auth/sign-out', {
      headers: { ...cookie(alice.token), origin: ORIGIN },
      method: 'POST',
    });

    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual(CLEARED);
    expect(await socket.closed).toBe(4001);
    const afterSignOut = await call('/api/rooms', { headers: cookie(alice.token) });
    expect(afterSignOut.status).toBe(401);

    const again = await call('/api/auth/sign-out', {
      headers: { ...cookie(alice.token), origin: ORIGIN },
      method: 'POST',
    });
    expect(again.status).toBe(401);
    expect(again.headers.getSetCookie()).toEqual(CLEARED);
    const none = await call('/api/auth/sign-out', { headers: { origin: ORIGIN }, method: 'POST' });
    expect(none.status).toBe(401);
    expect(none.headers.getSetCookie()).toEqual(CLEARED);
  });
});

describe('absolute session lifetime (S3)', () => {
  test('refresh answers 401 once the session started more than SESSION_MAX_AGE_SECONDS ago', async () => {
    const alice = await signUp('ckage');
    const user = new User(UserId.restore(alice.id), UserName.restore(alice.name), PasswordHash.restore('x'));
    const issuer = new JoseTokenIssuer(SECRET);
    const now = Date.now();
    const old = await issuer.issue(user, {
      id: crypto.randomUUID(),
      startedAt: new Date(now - (MAX_AGE_SECONDS + 5) * 1000),
    });
    const recent = await issuer.issue(user, {
      id: crypto.randomUUID(),
      startedAt: new Date(now - (MAX_AGE_SECONDS - 60) * 1000),
    });

    const refused = await call('/api/auth/refresh', {
      headers: { authorization: `Bearer ${old.token}` },
      method: 'POST',
    });
    const allowed = await call('/api/auth/refresh', {
      headers: { authorization: `Bearer ${recent.token}` },
      method: 'POST',
    });

    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ message: 'Invalid or expired token' });
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(allowed.status).toBe(200);
    // The token of an old session still works until it expires on its own; only refresh stops.
    const stillValid = await call('/api/rooms', { headers: { authorization: `Bearer ${old.token}` } });
    expect(stillValid.status).toBe(200);
  });
});

describe('per-account sign-in throttle (S7)', () => {
  test.each([
    ['a known name', true],
    ['an unknown name', false],
  ])(
    'after %s spends its bucket, sign-in answers 429 with Retry-After, even with the right password',
    async (_case, known) => {
      const name = known ? await signUp('ckthr').then((user) => user.name) : freshName('ckghost');
      const attempt = async (password: string): Promise<number> => {
        const response = await call('/api/auth/sign-in', { body: { name, password }, method: 'POST' });
        return response.status;
      };

      const statuses: number[] = [];
      for (let index = 0; index < SIGNIN_CAPACITY; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- the bucket is spent in order
        statuses.push(await attempt('wrong-Password-77'));
      }
      const throttled = await call('/api/auth/sign-in', { body: { name, password: PASSWORD }, method: 'POST' });

      expect(statuses).toEqual(Array.from({ length: SIGNIN_CAPACITY }, () => 401));
      expect(throttled.status).toBe(429);
      expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await throttled.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
    },
  );
});
