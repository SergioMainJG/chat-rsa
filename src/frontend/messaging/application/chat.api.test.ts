import { describe, expect, test } from 'bun:test';

import { ChatApi, type FetchLike } from './chat.api.ts';

type Call = { readonly init: RequestInit; readonly url: string };

const ROOM = { id: 'r1', keyEpoch: 2, memberIds: [1, 2], name: 'general' };
const MESSAGE = {
  authTag: 'tag',
  chainIndex: 0,
  ciphertext: 'ct',
  createdAt: '2026-11-12T10:00:00.000Z',
  id: '019a0000-0000-7000-8000-000000000001',
  idempotencyKey: 'k',
  iv: 'iv',
  keyEpoch: 2,
  roomId: 'r1',
  senderId: 2,
};

function headersOf(call: Call | undefined): Headers {
  return new Headers(call?.init.headers);
}

function setup(respond: (call: Call) => Promise<Response> | Response): {
  api: ChatApi;
  calls: Call[];
  unauthorized: number[];
} {
  const calls: Call[] = [];
  const unauthorized: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { init, url };
    calls.push(call);
    return respond(call);
  };
  const api = new ChatApi({
    fetch,
    onUnauthorized: () => {
      unauthorized.push(1);
    },
  });
  return { api, calls, unauthorized };
}

describe('ChatApi', () => {
  test('sends no Authorization header (the session cookie goes same-origin), and JSON with its content type', async () => {
    const { api, calls } = setup(() => Response.json(ROOM, { status: 201 }));

    await api.createRoom('general', [2]);

    const [call] = calls;
    expect(call?.url).toBe('/api/rooms');
    expect(call?.init.method).toBe('POST');
    expect(headersOf(call).has('authorization')).toBe(false);
    expect(call?.init.credentials).toBe('same-origin');
    expect(headersOf(call).get('content-type')).toBe('application/json');
    expect(call?.init.body).toBe(JSON.stringify({ memberIds: [2], name: 'general' }));
  });

  test('a 401 reports the session as over, so the page redirects to sign-in', async () => {
    const { api, unauthorized } = setup(() => Response.json({ message: 'Unauthorized' }, { status: 401 }));

    expect(await api.listRooms()).toEqual({ kind: 'unauthorized' });
    expect(unauthorized).toEqual([1]);
  });

  test('a 429 carries the Retry-After seconds', async () => {
    const { api } = setup(() =>
      Response.json({ message: 'Too many requests' }, { headers: { 'retry-after': '7' }, status: 429 }),
    );

    expect(await api.listRooms()).toEqual({ kind: 'rate-limited', retryAfterSeconds: 7 });
  });

  test('a 429 without a usable Retry-After waits one second', async () => {
    const { api } = setup(() => new Response(null, { status: 429 }));

    expect(await api.listRooms()).toEqual({ kind: 'rate-limited', retryAfterSeconds: 1 });
  });

  test('listRooms returns the parsed rooms', async () => {
    const { api } = setup(() => Response.json([ROOM]));

    expect(await api.listRooms()).toEqual({ kind: 'ok', value: [ROOM] });
  });

  test('a body of the wrong shape is a failure, not a crash', async () => {
    const { api } = setup(() => Response.json([{ id: 1 }]));

    expect(await api.listRooms()).toEqual({
      kind: 'failure',
      message: 'Unexpected response from the server',
      status: 200,
    });
  });

  test('a server error keeps its message', async () => {
    const { api } = setup(() => Response.json({ message: 'A room needs at least 2 members' }, { status: 400 }));

    expect(await api.createRoom('x', [])).toEqual({
      kind: 'failure',
      message: 'A room needs at least 2 members',
      status: 400,
    });
  });

  test('a network error is a failure with status 0', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(await api.listRooms()).toEqual({
      kind: 'failure',
      message: 'Network error. Check your connection.',
      status: 0,
    });
  });

  test('findUser encodes the name and maps 404 to not-found', async () => {
    const { api, calls } = setup(() => Response.json({ message: 'User not found' }, { status: 404 }));

    expect(await api.findUser('a b')).toEqual({ kind: 'not-found', message: 'User not found' });
    expect(calls[0]?.url).toBe('/api/users/a%20b');
  });

  test('findUser returns the public user', async () => {
    const { api } = setup(() => Response.json({ id: 2, name: 'bob' }));

    expect(await api.findUser('bob')).toEqual({ kind: 'ok', value: { id: 2, name: 'bob' } });
  });

  test('history passes the cursor and limit and parses the page', async () => {
    const { api, calls } = setup(() => Response.json({ messages: [MESSAGE], nextBefore: MESSAGE.id }));

    expect(await api.history('r1', { before: 'cursor', limit: 50 })).toEqual({
      kind: 'ok',
      value: { messages: [MESSAGE], nextBefore: MESSAGE.id },
    });
    expect(calls[0]?.url).toBe('/api/rooms/r1/messages?before=cursor&limit=50');
    expect(calls[0]?.init.method).toBe('GET');
  });

  test('the first history page has no before parameter', async () => {
    const { api, calls } = setup(() => Response.json({ messages: [], nextBefore: null }));

    await api.history('r1', { limit: 50 });

    expect(calls[0]?.url).toBe('/api/rooms/r1/messages?limit=50');
  });

  test('leaveRoom accepts an empty 204', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }));

    expect(await api.leaveRoom('r1')).toEqual({ kind: 'ok', value: null });
    expect(calls[0]?.url).toBe('/api/rooms/r1/members/me');
    expect(calls[0]?.init.method).toBe('DELETE');
  });

  test('addMember posts the user id and returns the room', async () => {
    const { api, calls } = setup(() => Response.json(ROOM));

    expect(await api.addMember('r1', 2)).toEqual({ kind: 'ok', value: ROOM });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ userId: 2 }));
  });

  test('receipts, keys and sender keys are parsed', async () => {
    const receipts = [{ delivered: null, read: MESSAGE.id, userId: 2 }];
    const keys = [{ publicKey: 'pk', userId: 2 }];
    const envelopes = [
      {
        authTag: 't',
        ciphertext: 'c',
        ephemeralPublicKey: 'e',
        iv: 'i',
        keyEpoch: 2,
        recipientId: 1,
        roomId: 'r1',
        senderId: 2,
      },
    ];
    const { api, calls } = setup(({ url }) => {
      if (url.endsWith('/receipts')) {
        return Response.json(receipts);
      }
      return url.endsWith('/keys') ? Response.json(keys) : Response.json(envelopes);
    });

    expect(await api.receipts('r1')).toEqual({ kind: 'ok', value: receipts });
    expect(await api.roomKeys('r1')).toEqual({ kind: 'ok', value: keys });
    expect(await api.senderKeys('r1', 2)).toEqual({ kind: 'ok', value: envelopes });
    expect(calls[2]?.url).toBe('/api/rooms/r1/sender-keys?keyEpoch=2');
  });

  test('uploadSenderKeys and publishIdentity send their bodies', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }));

    expect(await api.uploadSenderKeys('r1', 3, [])).toEqual({ kind: 'ok', value: null });
    expect(await api.publishIdentity('pk')).toEqual({ kind: 'ok', value: null });
    expect(calls.map((call) => [call.init.method, call.url, call.init.body])).toEqual([
      ['POST', '/api/rooms/r1/sender-keys', JSON.stringify({ envelopes: [], keyEpoch: 3 })],
      ['PUT', '/api/keys/identity', JSON.stringify({ publicKey: 'pk' })],
    ]);
  });

  test('uploadSenderKeys sends each envelope with only the fields the server accepts', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 201 }));
    const envelope = {
      authTag: 'tag',
      ciphertext: 'ct',
      ephemeralPublicKey: 'epk',
      iv: 'iv',
      keyEpoch: 3,
      recipientId: 7,
      roomId: 'r1',
    };

    expect(await api.uploadSenderKeys('r1', 3, [envelope])).toEqual({ kind: 'ok', value: null });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        envelopes: [{ authTag: 'tag', ciphertext: 'ct', ephemeralPublicKey: 'epk', iv: 'iv', recipientId: 7 }],
        keyEpoch: 3,
      }),
    );
  });

  test('refresh returns the new session', async () => {
    const session = { user: { id: 1, name: 'alice' } };
    const { api, calls } = setup(() => Response.json(session));

    expect(await api.refresh()).toEqual({ kind: 'ok', value: session });
    expect(calls[0]?.url).toBe('/api/auth/refresh');
    expect(calls[0]?.init.method).toBe('POST');
  });
});
