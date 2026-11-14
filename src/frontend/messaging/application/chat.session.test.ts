import { describe, expect, test } from 'bun:test';

import { InMemoryKeyStore } from '../crypto/messaging.crypto.key-store.ts';
import { bootstrapSession, type ChatSession, type TokenStore } from './chat.session.ts';

type Call = { readonly body: unknown; readonly method: string; readonly url: string };

class MemoryTokens implements TokenStore {
  constructor(public token: null | string) {}

  clear = (): void => {
    this.token = null;
  };

  get = (): null | string => this.token;

  set = (token: string): void => {
    this.token = token;
  };
}

function server(routes: Record<string, () => Response>): {
  calls: Call[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      calls.push({ body: typeof init.body === 'string' ? JSON.parse(init.body) : null, method, url });
      return routes[`${method} ${url}`]?.() ?? new Response(null, { status: 404 });
    },
  };
}

/** A navigate that records nothing, for tests that do not check redirects. */
function ignore(): void {
  // Navigation is not observed here.
}

const SESSION = { token: 'fresh', user: { id: 1, name: 'alice' } };

describe('bootstrapSession', () => {
  test('without a token it redirects to /sign-in and fetches nothing', async () => {
    const { calls, fetch } = server({});
    const navigated: string[] = [];

    const result = await bootstrapSession({
      fetch,
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: (path) => navigated.push(path),
      tokens: new MemoryTokens(null),
    });

    expect(result).toEqual({ kind: 'redirected' });
    expect(navigated).toEqual(['/sign-in']);
    expect(calls).toEqual([]);
  });

  test('a 401 on the session refresh clears the token and redirects', async () => {
    const { fetch } = server({ 'POST /api/auth/refresh': () => Response.json({}, { status: 401 }) });
    const navigated: string[] = [];
    const tokens = new MemoryTokens('old');

    const result = await bootstrapSession({
      fetch,
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: (path) => navigated.push(path),
      tokens,
    });

    expect(result).toEqual({ kind: 'redirected' });
    expect(navigated).toEqual(['/sign-in']);
    expect(tokens.token).toBeNull();
  });

  test('stores the refreshed token and publishes the identity key once', async () => {
    const { calls, fetch } = server({
      'POST /api/auth/refresh': () => Response.json(SESSION),
      'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    });
    const tokens = new MemoryTokens('old');
    const keyStore = new InMemoryKeyStore();
    const deps = { fetch, keyStoreFor: () => keyStore, navigate: ignore, tokens };

    const first = await bootstrapSession(deps);
    const second = await bootstrapSession(deps);

    expect(first.kind).toBe('ready');
    expect(first.kind === 'ready' && first.session.user).toEqual(SESSION.user);
    expect(second.kind).toBe('ready');
    expect(tokens.token).toBe('fresh');
    const publishes = calls.filter((call) => call.url === '/api/keys/identity');
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.method).toBe('PUT');
    expect(publishes[0]?.body).toEqual({ publicKey: expect.any(String) });
    expect(await keyStore.getIdentity()).not.toBeNull();
  });

  test('a failed identity publish is reported and stores no identity', async () => {
    const { fetch } = server({
      'POST /api/auth/refresh': () => Response.json(SESSION),
      'PUT /api/keys/identity': () => Response.json({ message: 'Boom' }, { status: 500 }),
    });
    const keyStore = new InMemoryKeyStore();

    const result = await bootstrapSession({
      fetch,
      keyStoreFor: () => keyStore,
      navigate: ignore,
      tokens: new MemoryTokens('old'),
    });

    expect(result).toEqual({ kind: 'failed', message: 'Boom' });
    expect(await keyStore.getIdentity()).toBeNull();
  });

  test('refreshToken stores and returns the new token, and rejects when the session is over', async () => {
    let status = 200;
    const { fetch } = server({
      'POST /api/auth/refresh': () =>
        status === 200 ? Response.json({ ...SESSION, token: `t${status}` }) : Response.json({}, { status }),
      'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    });
    const tokens = new MemoryTokens('old');
    const result = await bootstrapSession({
      fetch,
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: ignore,
      tokens,
    });
    if (result.kind !== 'ready') {
      throw new Error('expected a ready session');
    }

    expect(await result.session.refreshToken()).toBe('t200');
    expect(tokens.token).toBe('t200');

    status = 401;
    const failure = await result.session.refreshToken().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe('Session expired');
  });

  test('two users signed in on the same browser each get and publish their own identity key', async () => {
    let signedIn = { token: 'fresh', user: { id: 1, name: 'alice' } };
    const { calls, fetch } = server({
      'POST /api/auth/refresh': () => Response.json(signedIn),
      'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    });
    const browser = new Map<number, InMemoryKeyStore>();
    const keyStoreFor = (userId: number): InMemoryKeyStore => {
      const store = browser.get(userId) ?? new InMemoryKeyStore();
      browser.set(userId, store);
      return store;
    };

    const alice = await bootstrapSession({ fetch, keyStoreFor, navigate: ignore, tokens: new MemoryTokens('a') });
    signedIn = { token: 'fresh', user: { id: 2, name: 'bob' } };
    const bob = await bootstrapSession({ fetch, keyStoreFor, navigate: ignore, tokens: new MemoryTokens('b') });

    expect(alice.kind === 'ready' && alice.session.user.id).toBe(1);
    expect(bob.kind === 'ready' && bob.session.user.id).toBe(2);
    const published = calls.filter((call) => call.url === '/api/keys/identity').map((call) => call.body);
    expect(published).toHaveLength(2);
    expect(published[0]).not.toEqual(published[1]);
    const aliceKey = await browser.get(1)?.getIdentity();
    const bobKey = await browser.get(2)?.getIdentity();
    expect(aliceKey).toBeTruthy();
    expect(bobKey).toBeTruthy();
    expect(aliceKey).not.toBe(bobKey);
  });
});

async function readySession(routes: Record<string, () => Response>): Promise<{
  calls: Call[];
  session: ChatSession;
  tokens: MemoryTokens;
}> {
  const { calls, fetch } = server({
    'POST /api/auth/refresh': () => Response.json(SESSION),
    'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    ...routes,
  });
  const tokens = new MemoryTokens('old');
  const result = await bootstrapSession({
    fetch,
    keyStoreFor: () => new InMemoryKeyStore(),
    navigate: ignore,
    tokens,
  });
  if (result.kind !== 'ready') {
    throw new Error('expected a ready session');
  }
  return { calls, session: result.session, tokens };
}

describe('ChatSession.signOut', () => {
  test('revokes the session on the server with the current token, then forgets the token', async () => {
    const { calls, session, tokens } = await readySession({
      'POST /api/auth/sign-out': () => new Response(null, { status: 204 }),
    });

    await session.signOut();

    const signOut = calls.find((call) => call.url === '/api/auth/sign-out');
    expect(signOut?.method).toBe('POST');
    expect(tokens.token).toBeNull();
  });

  test('forgets the token even when the server cannot be reached or refuses', async () => {
    for (const answer of [
      () => Response.json({ message: 'Boom' }, { status: 500 }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one failure mode at a time
      const { session, tokens } = await readySession({ 'POST /api/auth/sign-out': answer });
      // eslint-disable-next-line no-await-in-loop -- one failure mode at a time
      await session.signOut();
      expect(tokens.token).toBeNull();
    }
  });
});
