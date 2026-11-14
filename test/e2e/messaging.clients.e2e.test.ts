import { RedisClient } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { MessageItem } from '../../src/frontend/messaging/presentation/chat.view-model.ts';

import { composeApp } from '../../src/backend/app.composition.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import { ChatController } from '../../src/frontend/messaging/application/chat.controller.ts';
import {
  bootstrapSession,
  type ChatSession,
  type TokenStore,
} from '../../src/frontend/messaging/application/chat.session.ts';
import { SocketConnection, type Timers } from '../../src/frontend/messaging/connection/messaging.connection.ts';
import { InMemoryOutbox } from '../../src/frontend/messaging/connection/messaging.outbox.ts';
import { InMemoryKeyStore } from '../../src/frontend/messaging/crypto/messaging.crypto.key-store.ts';
import { InMemoryLocalMessageStore } from '../../src/frontend/messaging/search/messaging.search.ts';
import { BEARER_PREFIX, SOCKET_PATH, SOCKET_PROTOCOL } from '../../src/shared/contracts/messaging.socket.contract.ts';

// Two real chat clients (session bootstrap, controller, socket connection and Web Crypto sender keys)
// talking through the real server, the way two devices do.

type Client = {
  readonly controller: ChatController;
  readonly messages: () => readonly MessageItem[];
  readonly session: ChatSession;
};

/**
 * One account on one device: what survives a sign-out on a real browser (the per-user key store and decrypted local
 * store in IndexedDB) and the token slot of `sessionStorage`.
 */
type Device = {
  readonly keyStore: InMemoryKeyStore;
  readonly name: string;
  readonly store: InMemoryLocalMessageStore;
  readonly tokens: TokenStore;
};

/** What a person sees of one message; ids and times are compared separately. */
type Seen = Pick<MessageItem, 'id' | 'own' | 'sender' | 'status' | 'text' | 'undecryptable'>;

const PASSWORD = 'correct-Horse-battery-st4ple';
const SECRET = 'e2e-clients-secret';
const config = loadConfig();
const sql = createPostgresClient({ max: 4, url: config.databaseUrl });
const cache = new RedisClient(config.cacheUrl);
const createdUsers: string[] = [];
const clients: Client[] = [];
let server: ReturnType<typeof createServer>;

const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
let timerSeq = 0;
const timers: Timers = {
  clearTimeout: (handle) => {
    clearTimeout(pendingTimers.get(handle));
    pendingTimers.delete(handle);
  },
  setTimeout: (callback, ms) => {
    timerSeq += 1;
    const handle = timerSeq;
    pendingTimers.set(
      handle,
      setTimeout(() => {
        pendingTimers.delete(handle);
        callback();
      }, ms),
    );
    return handle;
  },
};

/** For callbacks these tests do not observe. */
function ignore(): void {
  // Nothing to record.
}

beforeAll(async () => {
  await applyUserSchema(sql);
  const { auth, messaging } = composeApp({
    cache,
    config: { jwtSecret: SECRET, rateLimit: config.rateLimit },
    hasher: new Argon2PasswordHasher(),
    logger: { error: (error) => console.error(error) },
    sql,
    tokens: new JoseTokenIssuer(SECRET),
  });
  server = createServer({ auth, messaging, port: 0 });
});

afterAll(async () => {
  for (const client of clients) {
    client.controller.stop();
  }
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  await server.stop(true);
  await sql`DELETE FROM rooms WHERE id IN (
    SELECT room_id FROM room_members m JOIN users u ON u.id = m.user_id WHERE u.name IN ${sql(createdUsers)}
  )`;
  await sql`DELETE FROM users WHERE name IN ${sql(createdUsers)}`;
  await sql.close();
  cache.close();
});

async function authenticate(path: string, name: string): Promise<string> {
  const response = await fetch(new URL(path, server.url), {
    body: JSON.stringify({ name, password: PASSWORD }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('token' in body) || typeof body.token !== 'string') {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return body.token;
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    // eslint-disable-next-line no-await-in-loop -- polls the client state
    await Bun.sleep(50);
  }
}

/** Creates an account on a fresh device; the device is signed in with its first token. */
async function signIn(device: Device): Promise<void> {
  device.tokens.set(await authenticate('/api/auth/sign-in', device.name));
}

async function signUp(prefix: string): Promise<Device> {
  const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  createdUsers.push(name);
  let token: null | string = await authenticate('/api/auth/sign-up', name);
  const tokens: TokenStore = {
    clear: () => {
      token = null;
    },
    get: () => token,
    set: (next) => {
      token = next;
    },
  };
  return { keyStore: new InMemoryKeyStore(), name, store: new InMemoryLocalMessageStore(), tokens };
}

/** Opens the chat page on the device: bootstraps the session and builds the controller. */
async function openChat(device: Device): Promise<Client> {
  const { tokens } = device;
  const result = await bootstrapSession({
    fetch: async (url, init) => fetch(new URL(url, server.url), init),
    keyStoreFor: () => device.keyStore,
    navigate: ignore,
    tokens,
  });
  if (result.kind !== 'ready') {
    throw new Error(`bootstrap ${result.kind}`);
  }
  const { session } = result;
  let messages: readonly MessageItem[] = [];
  const controller = new ChatController({
    api: session.api,
    connect: ({ onFrame, onState }) =>
      new SocketConnection({
        createSocket: (url, protocols, listener) => {
          const socket = new WebSocket(url, protocols);
          socket.addEventListener('open', () => {
            listener.onOpen();
          });
          socket.addEventListener('message', (event) => {
            listener.onMessage(String(event.data));
          });
          socket.addEventListener('close', (event) => {
            listener.onClose(event.code);
          });
          return {
            close: (code) => {
              socket.close(code);
            },
            send: (data) => {
              socket.send(data);
            },
          };
        },
        getToken: () => tokens.get(),
        network: { isOnline: () => true, onChange: () => ignore },
        now: Date.now,
        onFrame,
        onState,
        random: Math.random,
        refreshToken: session.refreshToken,
        timers,
        url: socketUrl(),
      }),
    crypto: session.crypto,
    formatTime: (iso) => iso,
    isDocumentVisible: () => true,
    now: Date.now,
    outbox: new InMemoryOutbox(),
    randomUUID: () => crypto.randomUUID(),
    store: device.store,
    timers,
    user: session.user,
    view: {
      notify: ignore,
      renderConnection: ignore,
      renderMessages: (items) => {
        messages = items;
      },
      renderRoom: ignore,
      renderRooms: ignore,
      renderSearch: ignore,
      renderTyping: ignore,
    },
  });
  const client = { controller, messages: () => messages, session };
  clients.push(client);
  return client;
}

function seen(client: Client): Seen[] {
  return client.messages().map(({ id, own, sender, status, text, undecryptable }) => ({
    id,
    own,
    sender,
    status,
    text,
    undecryptable,
  }));
}

function socketUrl(): string {
  return new URL(SOCKET_PATH, server.url.href.replace(/^http/u, 'ws')).href;
}

/** Resolves with the close code of a socket opened with `token`, or 0 when it opened. */
async function upgradeOutcome(token: string): Promise<number> {
  const socket = new WebSocket(socketUrl(), [SOCKET_PROTOCOL, `${BEARER_PREFIX}${token}`]);
  return new Promise((resolve) => {
    socket.addEventListener('open', () => {
      socket.close();
      resolve(0);
    });
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
}

describe('two chat clients through the real server', () => {
  test('a message is delivered, decrypted and attributed to its sender on both sides', async () => {
    const alice = await openChat(await signUp('cla'));
    const bobDevice = await signUp('clb');
    const bob = await openChat(bobDevice);
    await alice.controller.start(null);
    expect(await alice.controller.createRoom('pair', bobDevice.name)).toBeNull();
    const roomId = alice.controller.activeRoomId;
    expect(roomId).not.toBeNull();
    await bob.controller.start(roomId);

    await alice.controller.send('hola');

    const aliceSees = (): MessageItem | undefined => alice.messages().find((item) => item.text === 'hola');
    const bobSees = (): MessageItem | undefined => bob.messages().find((item) => item.id !== null);
    await eventually(() => aliceSees()?.status === 'delivered' || aliceSees()?.status === 'read', 'ack');
    await eventually(() => bobSees() !== undefined, 'bob to receive the message');
    await eventually(() => bobSees()?.undecryptable === false, 'bob to decrypt the message');

    expect(aliceSees()).toMatchObject({ own: true, sender: 'You', text: 'hola' });
    expect(bobSees()).toMatchObject({ own: false, text: 'hola', undecryptable: false });
    expect(bobSees()?.sender).not.toBe('You');
  }, 20_000);

  test('two users talk 20 messages, sign out, sign in again and find the chat as they left it', async () => {
    const aliceDevice = await signUp('jra');
    const bobDevice = await signUp('jrb');
    const alice = await openChat(aliceDevice);
    const bob = await openChat(bobDevice);
    await alice.controller.start(null);
    expect(await alice.controller.createRoom('journey', bobDevice.name)).toBeNull();
    const roomId = alice.controller.activeRoomId;
    await bob.controller.start(roomId);

    for (let index = 1; index <= 20; index += 1) {
      const [from, to] = index % 2 === 1 ? [alice, bob] : [bob, alice];
      const text = `message ${index}`;
      // eslint-disable-next-line no-await-in-loop -- a conversation: each reply waits for the last message
      await from.controller.send(text);
      // eslint-disable-next-line no-await-in-loop -- a conversation: each reply waits for the last message
      await eventually(
        () => to.messages().some((item) => item.text === text && !item.undecryptable),
        `${text} to arrive decrypted`,
      );
      // What the page's IntersectionObserver does when the message scrolls into view.
      const arrived = to.messages().find((item) => item.text === text);
      if (arrived?.id) {
        to.controller.messageVisibility(arrived.id, true);
        to.controller.flushReads();
      }
    }
    const expectedTexts = Array.from({ length: 20 }, (_, index) => `message ${index + 1}`);
    await eventually(
      () => [alice, bob].every((client) => client.messages().every((item) => !item.own || item.status === 'read')),
      'every message to be read',
    );
    await eventually(
      () => [alice, bob].every((client) => client.messages().every((item) => !item.sender.startsWith('User '))),
      'every sender to show by name',
    );
    const aliceBefore = seen(alice);
    const bobBefore = seen(bob);
    expect(aliceBefore.map((item) => item.text)).toEqual(expectedTexts);
    expect(bobBefore.map((item) => item.text)).toEqual(expectedTexts);
    expect(aliceBefore.map((item) => item.own)).toEqual(expectedTexts.map((_, index) => index % 2 === 0));
    expect(bobBefore.map((item) => item.own)).toEqual(expectedTexts.map((_, index) => index % 2 === 1));

    const oldTokens = [aliceDevice.tokens.get(), bobDevice.tokens.get()];
    for (const [client, device] of [
      [alice, aliceDevice],
      [bob, bobDevice],
    ] as const) {
      client.controller.stop();
      // eslint-disable-next-line no-await-in-loop -- each user signs out on their own device
      await client.session.signOut();
      expect(device.tokens.get()).toBeNull();
    }
    for (const token of oldTokens) {
      if (token === null) {
        throw new Error('expected a signed-in token');
      }
      const headers = { authorization: `Bearer ${token}` };
      // eslint-disable-next-line no-await-in-loop -- one revoked token at a time
      const refresh = await fetch(new URL('/api/auth/refresh', server.url), { headers, method: 'POST' });
      // eslint-disable-next-line no-await-in-loop -- one revoked token at a time
      const rooms = await fetch(new URL('/api/rooms', server.url), { headers });
      expect(refresh.status).toBe(401);
      expect(rooms.status).toBe(401);
      // eslint-disable-next-line no-await-in-loop -- one revoked token at a time
      expect(await upgradeOutcome(token)).not.toBe(0);
    }

    await signIn(aliceDevice);
    await signIn(bobDevice);
    const aliceAgain = await openChat(aliceDevice);
    const bobAgain = await openChat(bobDevice);
    await aliceAgain.controller.start(roomId);
    await bobAgain.controller.start(roomId);

    // Names, receipts and history load in parallel: wait until the view settles on what was left.
    await eventually(
      () => Bun.deepEquals(seen(aliceAgain), aliceBefore) && Bun.deepEquals(seen(bobAgain), bobBefore),
      'the chat to look as it was left',
    );
    expect(seen(aliceAgain)).toEqual(aliceBefore);
    expect(seen(bobAgain)).toEqual(bobBefore);
  }, 60_000);
});
