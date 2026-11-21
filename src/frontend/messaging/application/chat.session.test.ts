import { describe, expect, test } from 'bun:test';

import { InMemoryKeyStore } from '../crypto/messaging.crypto.key-store.ts';
import { bootstrapSession, type ChatSession, type SessionHint } from './chat.session.ts';

type Call = { readonly body: unknown; readonly method: string; readonly url: string };

/** The `chat_rsa_session_hint` cookie as the page sees it; the JWT itself is never visible. */
class MemoryHint implements SessionHint {
  constructor(public live: boolean) {}

  clear = (): void => {
    this.live = false;
  };

  isLive = (): boolean => this.live;
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

const SESSION = { user: { id: 1, name: 'alice' } };

describe('bootstrapSession', () => {
  test('without a live session hint it redirects to /sign-in and fetches nothing', async () => {
    const { calls, fetch } = server({});
    const navigated: string[] = [];

    const result = await bootstrapSession({
      fetch,
      hint: new MemoryHint(false),
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: (path) => navigated.push(path),
    });

    expect(result).toEqual({ kind: 'redirected' });
    expect(navigated).toEqual(['/en/sign-in']);
    expect(calls).toEqual([]);
  });

  test('a 401 on the session refresh clears the hint and redirects', async () => {
    const { fetch } = server({ 'POST /api/auth/refresh': () => Response.json({}, { status: 401 }) });
    const navigated: string[] = [];
    const hint = new MemoryHint(true);

    const result = await bootstrapSession({
      fetch,
      hint,
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: (path) => navigated.push(path),
    });

    expect(result).toEqual({ kind: 'redirected' });
    expect(navigated).toEqual(['/en/sign-in']);
    expect(hint.live).toBe(false);
  });

  test('refreshes the session (cookies only, no token in JS) and publishes the identity key once', async () => {
    const { calls, fetch } = server({
      'POST /api/auth/refresh': () => Response.json(SESSION),
      'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    });
    const hint = new MemoryHint(true);
    const keyStore = new InMemoryKeyStore();
    const deps = { fetch, hint, keyStoreFor: () => keyStore, navigate: ignore };

    const first = await bootstrapSession(deps);
    const second = await bootstrapSession(deps);

    expect(first.kind).toBe('ready');
    expect(first.kind === 'ready' && first.session.user).toEqual(SESSION.user);
    expect(second.kind).toBe('ready');
    expect(hint.live).toBe(true);
    expect(calls.filter((call) => call.url === '/api/auth/refresh')).toHaveLength(2);
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
      hint: new MemoryHint(true),
      keyStoreFor: () => keyStore,
      navigate: ignore,
    });

    expect(result).toEqual({ kind: 'failed', message: 'Boom' });
    expect(await keyStore.getIdentity()).toBeNull();
  });

  test('refreshSession renews the session over REST, and rejects when the session is over', async () => {
    let status = 200;
    const { calls, fetch } = server({
      'POST /api/auth/refresh': () => (status === 200 ? Response.json(SESSION) : Response.json({}, { status })),
      'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    });
    const result = await bootstrapSession({
      fetch,
      hint: new MemoryHint(true),
      keyStoreFor: () => new InMemoryKeyStore(),
      navigate: ignore,
    });
    if (result.kind !== 'ready') {
      throw new Error('expected a ready session');
    }

    await result.session.refreshSession();
    expect(calls.filter((call) => call.url === '/api/auth/refresh')).toHaveLength(2);

    status = 401;
    const failure = await result.session.refreshSession().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe('Session expired');
  });

  test('two users signed in on the same browser each get and publish their own identity key', async () => {
    let signedIn = { user: { id: 1, name: 'alice' } };
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

    const alice = await bootstrapSession({ fetch, hint: new MemoryHint(true), keyStoreFor, navigate: ignore });
    signedIn = { user: { id: 2, name: 'bob' } };
    const bob = await bootstrapSession({ fetch, hint: new MemoryHint(true), keyStoreFor, navigate: ignore });

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
  hint: MemoryHint;
  session: ChatSession;
}> {
  const { calls, fetch } = server({
    'POST /api/auth/refresh': () => Response.json(SESSION),
    'PUT /api/keys/identity': () => new Response(null, { status: 204 }),
    ...routes,
  });
  const hint = new MemoryHint(true);
  const result = await bootstrapSession({
    fetch,
    hint,
    keyStoreFor: () => new InMemoryKeyStore(),
    navigate: ignore,
  });
  if (result.kind !== 'ready') {
    throw new Error('expected a ready session');
  }
  return { calls, hint, session: result.session };
}

describe('ChatSession.signOut', () => {
  test('revokes the session on the server (by cookie), then deletes the hint cookie', async () => {
    const { calls, hint, session } = await readySession({
      'POST /api/auth/sign-out': () => new Response(null, { status: 204 }),
    });

    await session.signOut();

    const signOut = calls.find((call) => call.url === '/api/auth/sign-out');
    expect(signOut?.method).toBe('POST');
    expect(hint.live).toBe(false);
  });

  test('deletes the hint cookie even when the server cannot be reached or refuses', async () => {
    for (const answer of [
      () => Response.json({ message: 'Boom' }, { status: 500 }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one failure mode at a time
      const { hint, session } = await readySession({ 'POST /api/auth/sign-out': answer });
      // eslint-disable-next-line no-await-in-loop -- one failure mode at a time
      await session.signOut();
      expect(hint.live).toBe(false);
    }
  });
});
