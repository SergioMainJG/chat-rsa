import { beforeEach, describe, expect, test } from 'bun:test';

import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { Logger } from '../../shared/domain/logger.ts';
import type { MembershipChange, RoomEvents } from '../application/messaging.events.ts';

import { MAX_JSON_BODY_BYTES } from '../../shared/http/http.json-body.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import {
  InMemoryKeyDirectory,
  InMemoryMemberDirectory,
  InMemoryMessageRepository,
  InMemoryReceiptRepository,
  InMemoryRoomRepository,
  InMemorySenderKeyRepository,
  zeros,
} from '../application/messaging.fakes.test-support.ts';
import { HistoryUseCase } from '../application/messaging.history.use-case.ts';
import {
  FetchSenderKeysUseCase,
  ListRoomKeysUseCase,
  PublishIdentityKeyUseCase,
  StoreSenderKeysUseCase,
} from '../application/messaging.keys.use-case.ts';
import { ReceiptUseCase } from '../application/messaging.receipt.use-case.ts';
import { ListReceiptsUseCase } from '../application/messaging.receipts-list.use-case.ts';
import {
  AddMemberUseCase,
  CreateRoomUseCase,
  LeaveRoomUseCase,
  ListRoomMembersUseCase,
  ListRoomsUseCase,
} from '../application/messaging.rooms.use-case.ts';
import { SendMessageUseCase } from '../application/messaging.send-message.use-case.ts';
import { createMessagingController, type MessagingController } from './messaging.controller.ts';

const ALICE = UserId.restore(1);
const BOB = UserId.restore(2);
const CAROL = UserId.restore(3);
const DAVE = UserId.restore(4);
const MALLORY = UserId.restore(9);

type Fired =
  | { readonly change: MembershipChange; readonly kind: 'members'; readonly room: RoomSummary }
  | { readonly keyEpoch: number; readonly kind: 'sender-keys'; readonly roomId: string; readonly senderId: number };

let rooms: InMemoryRoomRepository;
let messages: InMemoryMessageRepository;
let receipts: InMemoryReceiptRepository;
let fired: Fired[];
let logged: unknown[];
let controller: MessagingController;

beforeEach(() => {
  rooms = new InMemoryRoomRepository();
  messages = new InMemoryMessageRepository();
  receipts = new InMemoryReceiptRepository(rooms);
  const keys = new InMemoryKeyDirectory();
  const senderKeys = new InMemorySenderKeyRepository();
  fired = [];
  logged = [];
  const events: RoomEvents = {
    membersChanged: (room, change) => {
      fired.push({ change, kind: 'members', room });
    },
    senderKeysAvailable: (roomId, keyEpoch, senderId) => {
      fired.push({ keyEpoch, kind: 'sender-keys', roomId, senderId });
    },
  };
  const logger: Logger = {
    error: (error) => {
      logged.push(error);
    },
  };
  controller = createMessagingController({
    events,
    logger,
    useCases: {
      addMember: new AddMemberUseCase(rooms),
      createRoom: new CreateRoomUseCase(rooms),
      fetchSenderKeys: new FetchSenderKeysUseCase(rooms, senderKeys),
      history: new HistoryUseCase(rooms, messages),
      leaveRoom: new LeaveRoomUseCase(rooms),
      listReceipts: new ListReceiptsUseCase(rooms, receipts),
      listRoomKeys: new ListRoomKeysUseCase(rooms, keys),
      listRoomMembers: new ListRoomMembersUseCase(
        rooms,
        new InMemoryMemberDirectory(
          new Map([
            [ALICE, 'alice'],
            [BOB, 'bob'],
            [CAROL, 'carol'],
            [MALLORY, 'mallory'],
          ]),
        ),
      ),
      listRooms: new ListRoomsUseCase(rooms),
      publishIdentityKey: new PublishIdentityKeyUseCase(keys),
      storeSenderKeys: new StoreSenderKeysUseCase(rooms, senderKeys),
    },
  });
});

function envelope(recipientId: number): Record<string, unknown> {
  return { authTag: zeros(16), ciphertext: zeros(32), ephemeralPublicKey: zeros(32), iv: zeros(12), recipientId };
}

function getRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function jsonRequest(method: string, path: string, body: unknown, contentType = 'application/json'): Request {
  return new Request(`http://localhost${path}`, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': contentType },
    method,
  });
}

async function trio(): Promise<RoomSummary> {
  const response = await controller.createRoom(
    jsonRequest('POST', '/api/rooms', { memberIds: [BOB, CAROL], name: 'Trio' }),
    ALICE,
  );
  expect(response.status).toBe(201);
  const room: RoomSummary = await response.json();
  return room;
}

describe('rooms', () => {
  test('POST /api/rooms answers 201 with the summary and GET lists it for members only', async () => {
    const room = await trio();

    const mine = await controller.listRooms(getRequest('/api/rooms'), BOB);
    const theirs = await controller.listRooms(getRequest('/api/rooms'), MALLORY);

    expect(room).toMatchObject({ memberIds: [ALICE, BOB, CAROL], name: 'Trio' });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual([room]);
    expect(await theirs.json()).toEqual([]);
  });

  test('POST /api/rooms rejects an unknown key with 400 and creates nothing', async () => {
    const response = await controller.createRoom(
      jsonRequest('POST', '/api/rooms', { createdBy: 7, memberIds: [BOB], name: 'X' }),
      ALICE,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ field: 'createdBy', message: 'Unknown field' }] });
    expect(rooms.rooms.size).toBe(0);
  });

  test('POST /api/rooms rejects a non-JSON media type with 415', async () => {
    const response = await controller.createRoom(
      jsonRequest('POST', '/api/rooms', { memberIds: [BOB], name: 'X' }, 'text/plain'),
      ALICE,
    );

    expect(response.status).toBe(415);
  });

  test('POST /api/rooms rejects a body over 64 KiB with 413', async () => {
    const response = await controller.createRoom(
      jsonRequest('POST', '/api/rooms', { memberIds: [BOB], name: 'x'.repeat(MAX_JSON_BODY_BYTES) }),
      ALICE,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'Payload Too Large', statusCode: 413 });
  });

  test('POST /api/rooms rejects a non-object body with 400', async () => {
    const response = await controller.createRoom(jsonRequest('POST', '/api/rooms', '[]'), ALICE);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Request body must be a JSON object' });
  });

  test('GET /api/rooms rejects any query parameter', async () => {
    const response = await controller.listRooms(getRequest('/api/rooms?all=1'), ALICE);

    expect(response.status).toBe(400);
  });
});

describe('membership', () => {
  test('adding a member answers 201 and then announces the change', async () => {
    const room = await trio();

    const response = await controller.addMember(
      jsonRequest('POST', `/api/rooms/${room.id}/members`, { userId: DAVE }),
      ALICE,
      room.id,
    );
    const updated: RoomSummary = await response.json();

    expect(response.status).toBe(201);
    expect(updated.memberIds).toEqual([ALICE, BOB, CAROL, DAVE]);
    expect(fired).toEqual([{ change: { added: DAVE, removed: null }, kind: 'members', room: updated }]);
  });

  test('leaving answers 200 and then announces the change', async () => {
    const room = await trio();

    const response = await controller.leaveRoom(
      new Request(`http://localhost/api/rooms/${room.id}/members/me`, { method: 'DELETE' }),
      CAROL,
      room.id,
    );
    const updated: RoomSummary = await response.json();

    expect(response.status).toBe(200);
    expect(updated.memberIds).toEqual([ALICE, BOB]);
    expect(fired).toEqual([{ change: { added: null, removed: CAROL }, kind: 'members', room: updated }]);
  });

  test('a failed add or leave announces nothing', async () => {
    const room = await trio();

    const duplicate = await controller.addMember(
      jsonRequest('POST', `/api/rooms/${room.id}/members`, { userId: BOB }),
      ALICE,
      room.id,
    );
    const badBody = await controller.addMember(
      jsonRequest('POST', `/api/rooms/${room.id}/members`, { role: 'admin', userId: DAVE }),
      ALICE,
      room.id,
    );

    expect(duplicate.status).toBe(409);
    expect(badBody.status).toBe(400);
    expect(fired).toEqual([]);
  });

  test('a thrown repository failure is a logged 500 and announces nothing', async () => {
    const room = await trio();
    const failure = new Error('db down');
    rooms.addMember = async (): Promise<never> => {
      throw failure;
    };

    const response = await controller.addMember(
      jsonRequest('POST', `/api/rooms/${room.id}/members`, { userId: DAVE }),
      ALICE,
      room.id,
    );

    expect(response.status).toBe(500);
    expect(logged).toEqual([failure]);
    expect(fired).toEqual([]);
  });
});

describe('history and receipts', () => {
  test('GET history returns a page, and receipts return every member watermark', async () => {
    const room = await trio();
    const sent = await new SendMessageUseCase(rooms, messages).execute(ALICE, {
      authTag: zeros(16),
      chainIndex: 0,
      ciphertext: 'AQID',
      idempotencyKey: crypto.randomUUID(),
      iv: zeros(12),
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });
    if (!sent.ok) {
      throw sent.error;
    }
    const messageId = sent.value.message.id;
    await new ReceiptUseCase(rooms, messages, receipts).execute(BOB, { kind: 'read', messageId, roomId: room.id });

    const history = await controller.history(getRequest(`/api/rooms/${room.id}/messages?limit=10`), BOB, room.id);
    const marks = await controller.receipts(getRequest(`/api/rooms/${room.id}/receipts`), CAROL, room.id);

    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ messages: [{ id: messageId }], nextBefore: null });
    expect(marks.status).toBe(200);
    expect(await marks.json()).toEqual([
      { delivered: null, read: null, userId: ALICE },
      { delivered: messageId, read: messageId, userId: BOB },
      { delivered: null, read: null, userId: CAROL },
    ]);
  });

  test.each([
    ['an unknown parameter', '?limit=5&order=asc', { field: 'order', message: 'Unknown field' }],
    ['a repeated parameter', '?limit=5&limit=6', { field: 'limit', message: 'Repeated field' }],
  ])('GET history rejects %s with 400', async (_label, query, error) => {
    const room = await trio();

    const response = await controller.history(getRequest(`/api/rooms/${room.id}/messages${query}`), BOB, room.id);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [error] });
  });
});

describe('members', () => {
  test('GET /api/rooms/:roomId/members answers the id and name of every member', async () => {
    const room = await trio();

    const response = await controller.members(getRequest(`/api/rooms/${room.id}/members`), CAROL, room.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: ALICE, name: 'alice' },
      { id: BOB, name: 'bob' },
      { id: CAROL, name: 'carol' },
    ]);
  });
});

describe('keys', () => {
  test('PUT /api/keys/identity publishes the key, and members read it', async () => {
    const room = await trio();
    const publicKey = zeros(32);

    const published = await controller.publishIdentityKey(jsonRequest('PUT', '/api/keys/identity', { publicKey }), BOB);
    const listed = await controller.roomKeys(getRequest(`/api/rooms/${room.id}/keys`), ALICE, room.id);

    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ publicKey, userId: BOB });
    expect(await listed.json()).toEqual([{ publicKey, userId: BOB }]);
  });

  test('PUT /api/keys/identity rejects an unknown key', async () => {
    const response = await controller.publishIdentityKey(
      jsonRequest('PUT', '/api/keys/identity', { privateKey: 'x', publicKey: zeros(32) }),
      BOB,
    );

    expect(response.status).toBe(400);
  });

  test('POST sender-keys answers 201, announces the epoch, and the recipient fetches its envelope', async () => {
    const room = await trio();

    const stored = await controller.storeSenderKeys(
      jsonRequest('POST', `/api/rooms/${room.id}/sender-keys`, {
        envelopes: [envelope(BOB), envelope(CAROL)],
        keyEpoch: room.keyEpoch,
      }),
      ALICE,
      room.id,
    );
    const fetched = await controller.fetchSenderKeys(
      getRequest(`/api/rooms/${room.id}/sender-keys?keyEpoch=${room.keyEpoch}`),
      BOB,
      room.id,
    );

    expect(stored.status).toBe(201);
    expect(await stored.json()).toEqual({ keyEpoch: room.keyEpoch, stored: 2 });
    expect(fired).toEqual([{ keyEpoch: room.keyEpoch, kind: 'sender-keys', roomId: room.id, senderId: ALICE }]);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject([{ recipientId: BOB, senderId: ALICE }]);
  });

  test('POST sender-keys rejects unknown keys inside an envelope and announces nothing', async () => {
    const room = await trio();

    const response = await controller.storeSenderKeys(
      jsonRequest('POST', `/api/rooms/${room.id}/sender-keys`, {
        envelopes: [{ ...envelope(BOB), note: 'hi' }],
        keyEpoch: room.keyEpoch,
      }),
      ALICE,
      room.id,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ field: 'envelopes[0].note', message: 'Unknown field' }] });
    expect(fired).toEqual([]);
  });

  test('GET sender-keys rejects an unknown parameter', async () => {
    const room = await trio();

    const response = await controller.fetchSenderKeys(
      getRequest(`/api/rooms/${room.id}/sender-keys?all=1`),
      BOB,
      room.id,
    );

    expect(response.status).toBe(400);
  });
});

describe('room authorization', () => {
  type RoomRoute = (roomId: string) => Promise<Response>;

  const routes: Array<[string, RoomRoute]> = [
    [
      'POST members',
      async (roomId) =>
        controller.addMember(jsonRequest('POST', `/api/rooms/${roomId}/members`, { userId: DAVE }), MALLORY, roomId),
    ],
    [
      'DELETE members/me',
      async (roomId) =>
        controller.leaveRoom(
          new Request(`http://localhost/api/rooms/${roomId}/members/me`, { method: 'DELETE' }),
          MALLORY,
          roomId,
        ),
    ],
    [
      'GET messages',
      async (roomId) => controller.history(getRequest(`/api/rooms/${roomId}/messages`), MALLORY, roomId),
    ],
    [
      'GET receipts',
      async (roomId) => controller.receipts(getRequest(`/api/rooms/${roomId}/receipts`), MALLORY, roomId),
    ],
    ['GET keys', async (roomId) => controller.roomKeys(getRequest(`/api/rooms/${roomId}/keys`), MALLORY, roomId)],
    ['GET members', async (roomId) => controller.members(getRequest(`/api/rooms/${roomId}/members`), MALLORY, roomId)],
    [
      'POST sender-keys',
      async (roomId) =>
        controller.storeSenderKeys(
          jsonRequest('POST', `/api/rooms/${roomId}/sender-keys`, { envelopes: [envelope(BOB)], keyEpoch: 3 }),
          MALLORY,
          roomId,
        ),
    ],
    [
      'GET sender-keys',
      async (roomId) => controller.fetchSenderKeys(getRequest(`/api/rooms/${roomId}/sender-keys`), MALLORY, roomId),
    ],
  ];

  test.each(routes)('%s answers 403 to a non-member and announces nothing', async (_label, call) => {
    const room = await trio();

    const response = await call(room.id);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'You are not a member of this room', statusCode: 403 });
    expect(fired).toEqual([]);
  });
});
