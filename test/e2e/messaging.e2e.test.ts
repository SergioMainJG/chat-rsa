import { RedisClient } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { HistoryPage, RoomSummary } from '../../src/shared/contracts/messaging.contract.ts';

import { composeApp } from '../../src/backend/app.composition.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import {
  BEARER_PREFIX,
  type ServerFrame,
  SOCKET_PATH,
  SOCKET_PROTOCOL,
} from '../../src/shared/contracts/messaging.socket.contract.ts';

// The whole feature over the real server: Postgres, Valkey, HTTP routes and the WebSocket gateway.

type Member = { readonly id: number; readonly name: string; readonly token: string };

type Socket = {
  readonly close: () => void;
  readonly next: (type: ServerFrame['type']) => Promise<ServerFrame>;
  readonly send: (frame: Record<string, unknown>) => void;
};

const PASSWORD = 'correct-Horse-battery-st4ple';
const SECRET = 'e2e-messaging-secret';
const config = loadConfig();
const sql = createPostgresClient({ max: 4, url: config.databaseUrl });
const cache = new RedisClient(config.cacheUrl);
const createdUsers: string[] = [];
const createdRooms: string[] = [];
const sockets: Socket[] = [];
let server: ReturnType<typeof createServer>;
let alice: Member;
let bob: Member;
let mallory: Member;

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
  [alice, bob, mallory] = await Promise.all([signUp('alice'), signUp('bob'), signUp('mallory')]);
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.close();
  }
  await server.stop(true);
  if (createdRooms.length > 0) {
    await sql`DELETE FROM rooms WHERE id IN ${sql(createdRooms)}`;
  }
  await sql`DELETE FROM users WHERE name IN ${sql(createdUsers)}`;
  await sql.close();
  cache.close();
});

async function api(member: Member | null, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, server.url), {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(member && { authorization: `Bearer ${member.token}` }),
    },
  });
}

/** Opens `/ws` and buffers frames so tests can wait for one type at a time. */
async function connect(member: Member): Promise<Socket> {
  const ws = new WebSocket(new URL(SOCKET_PATH, server.url.href.replace(/^http/u, 'ws')), [
    SOCKET_PROTOCOL,
    `${BEARER_PREFIX}${member.token}`,
  ]);
  const buffered: ServerFrame[] = [];
  const waiting: Array<() => void> = [];
  ws.addEventListener('message', (event) => {
    const frame: ServerFrame = JSON.parse(String(event.data));
    buffered.push(frame);
    for (const wake of waiting.splice(0)) {
      wake();
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve();
    });
    ws.addEventListener('error', () => {
      reject(new Error('socket failed to open'));
    });
  });
  const socket: Socket = {
    close: () => {
      ws.close();
    },
    next: async (type) => {
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
        // eslint-disable-next-line no-await-in-loop -- waits for the next frame
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
    send: (frame) => {
      ws.send(JSON.stringify(frame));
    },
  };
  sockets.push(socket);
  return socket;
}

function sendFrame(
  roomId: string,
  keyEpoch: number,
  idempotencyKey: string,
  chainIndex: number,
): Record<string, unknown> {
  return {
    authTag: new Uint8Array(16).toBase64(),
    chainIndex,
    ciphertext: new Uint8Array([chainIndex + 1]).toBase64(),
    idempotencyKey,
    iv: new Uint8Array(12).toBase64(),
    keyEpoch,
    roomId,
    type: 'message.send',
  };
}

async function signUp(prefix: string): Promise<Member> {
  const name = `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  createdUsers.push(name);
  const response = await api(null, '/api/auth/sign-up', {
    body: JSON.stringify({ name, password: PASSWORD }),
    method: 'POST',
  });
  const body: { token: string; user: { id: number } } = await response.json();
  return { id: body.user.id, name, token: body.token };
}

describe('messaging over the real server', () => {
  let room: RoomSummary;

  test('REST requires a bearer token', async () => {
    const response = await api(null, '/api/rooms');
    expect(response.status).toBe(401);
  });

  test('a member creates a room of two; unknown fields are rejected', async () => {
    const response = await api(alice, '/api/rooms', {
      body: JSON.stringify({ memberIds: [bob.id], name: 'Duo' }),
      method: 'POST',
    });
    expect(response.status).toBe(201);
    const created: RoomSummary = await response.json();
    room = created;
    createdRooms.push(room.id);
    expect(room.memberIds.toSorted((a, b) => a - b)).toEqual([alice.id, bob.id].toSorted((a, b) => a - b));
    const strict = await api(alice, '/api/rooms', {
      body: JSON.stringify({ isAdmin: true, memberIds: [bob.id], name: 'Duo' }),
      method: 'POST',
    });
    expect(strict.status).toBe(400);
  });

  test('a non-member cannot read the history', async () => {
    const response = await api(mallory, `/api/rooms/${room.id}/messages`);
    expect(response.status).toBe(403);
  });

  test('a send is acked after persistence, fanned out once, and read receipts come back', async () => {
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    const ready = await aliceSocket.next('ready');
    expect(ready.type === 'ready' && ready.roomIds).toContain(room.id);
    await bobSocket.next('ready');

    const key = crypto.randomUUID();
    aliceSocket.send(sendFrame(room.id, room.keyEpoch, key, 0));
    const ack = await aliceSocket.next('message.ack');
    expect(ack.type === 'message.ack' && ack.duplicate).toBe(false);
    const messageId = ack.type === 'message.ack' ? ack.message.id : '';
    expect(messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
    const delivered = await bobSocket.next('message.new');
    expect(delivered.type === 'message.new' && delivered.message.id).toBe(messageId);

    // A retry over a flaky connection: acked as a duplicate, never stored or fanned out twice.
    aliceSocket.send(sendFrame(room.id, room.keyEpoch, key, 0));
    const retry = await aliceSocket.next('message.ack');
    expect(retry.type === 'message.ack' && retry.duplicate).toBe(true);
    aliceSocket.send(sendFrame(room.id, room.keyEpoch, crypto.randomUUID(), 1));
    await aliceSocket.next('message.ack');
    const following = await bobSocket.next('message.new');
    expect(following.type === 'message.new' && following.message.chainIndex).toBe(1);

    bobSocket.send({ kind: 'read', messageId, roomId: room.id, type: 'receipt' });
    const receipt = await aliceSocket.next('receipt');
    expect(receipt).toEqual({
      delivered: messageId,
      read: messageId,
      roomId: room.id,
      type: 'receipt',
      userId: bob.id,
    });

    const page = await api(bob, `/api/rooms/${room.id}/messages?limit=10`);
    const history: HistoryPage = await page.json();
    expect(history.messages.map((message) => message.chainIndex)).toEqual([1, 0]);
    const [count] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM messages WHERE room_id = ${room.id}`;
    expect(count?.n).toBe(2);
  });

  test('the upgrade rejects a socket without a valid token', async () => {
    const opened = await connect({ ...alice, token: 'not-a-jwt' }).then(
      () => true,
      () => false,
    );
    expect(opened).toBe(false);
  });

  test('a valid token is refreshed over HTTP', async () => {
    const response = await api(alice, '/api/auth/refresh', { method: 'POST' });
    expect(response.status).toBe(200);
    const body: { token: string; user: { id: number } } = await response.json();
    expect(body.user.id).toBe(alice.id);
    expect(body.token.split('.')).toHaveLength(3);
  });
});
