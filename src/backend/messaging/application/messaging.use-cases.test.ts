import { beforeEach, describe, expect, test } from 'bun:test';

import type { Result } from '../../shared/domain/result.ts';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { RoomId, uuidV7Bound } from '../domain/messaging.value-objects.ts';
import {
  InMemoryKeyDirectory,
  InMemoryMemberDirectory,
  InMemoryMessageRepository,
  InMemoryReceiptRepository,
  InMemoryRoomRepository,
  InMemorySenderKeyRepository,
  zeros,
} from './messaging.fakes.test-support.ts';
import { HistoryUseCase } from './messaging.history.use-case.ts';
import {
  FetchSenderKeysUseCase,
  ListRoomKeysUseCase,
  PublishIdentityKeyUseCase,
  StoreSenderKeysUseCase,
} from './messaging.keys.use-case.ts';
import { ReceiptUseCase } from './messaging.receipt.use-case.ts';
import {
  AddMemberUseCase,
  CreateRoomUseCase,
  LeaveRoomUseCase,
  ListRoomMembersUseCase,
  ListRoomsUseCase,
} from './messaging.rooms.use-case.ts';
import { SendMessageUseCase } from './messaging.send-message.use-case.ts';

const ALICE = UserId.restore(1);
const BOB = UserId.restore(2);
const CAROL = UserId.restore(3);
const MALLORY = UserId.restore(9);

let rooms: InMemoryRoomRepository;
let messages: InMemoryMessageRepository;
let receipts: InMemoryReceiptRepository;
let keys: InMemoryKeyDirectory;
let senderKeys: InMemorySenderKeyRepository;

beforeEach(() => {
  rooms = new InMemoryRoomRepository();
  messages = new InMemoryMessageRepository();
  receipts = new InMemoryReceiptRepository(rooms);
  keys = new InMemoryKeyDirectory();
  senderKeys = new InMemorySenderKeyRepository();
});

async function duo(): Promise<{ id: string; keyEpoch: number }> {
  return valueOf(await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [BOB], name: 'Duo' }));
}

function envelope(recipientId: number): Record<string, unknown> {
  return { authTag: zeros(16), ciphertext: zeros(32), ephemeralPublicKey: zeros(32), iv: zeros(12), recipientId };
}

async function seed(count: number): Promise<{ ids: string[]; roomId: string }> {
  const room = await duo();
  const useCase = new SendMessageUseCase(rooms, messages);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // Sequential on purpose: each message must get a later UUIDv7 than the previous one.
    // eslint-disable-next-line no-await-in-loop
    const sent = valueOf(await useCase.execute(ALICE, sendInput(room.id, room.keyEpoch, { chainIndex: index })));
    ids.push(sent.message.id);
  }
  return { ids, roomId: room.id };
}

function sendInput(roomId: string, keyEpoch: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authTag: zeros(16),
    chainIndex: 0,
    ciphertext: 'AQID',
    idempotencyKey: crypto.randomUUID(),
    iv: zeros(12),
    keyEpoch,
    roomId,
    ...overrides,
  };
}

/** Whether the use case succeeded, for tests that only check the guard. */
async function okOf(pending: Promise<Result<unknown, unknown>>): Promise<boolean> {
  const result = await pending;
  return result.ok;
}

function valueOf<T>(result: Result<T, unknown>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('CreateRoomUseCase', () => {
  test('creates a room with the creator as a member', async () => {
    const room = await duo();
    expect(rooms.rooms.get(RoomId.restore(room.id))?.memberIds).toEqual([ALICE, BOB]);
  });

  test('rejects a room without another member', async () => {
    const result = await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [], name: 'Solo' });
    expect(result).toEqual({
      error: new ValidationError([{ field: 'memberIds', message: 'A room needs 2 to 100 members' }]),
      ok: false,
    });
  });

  test('reports every invalid field', async () => {
    const result = await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: ['2'], name: '' });
    expect(result).toEqual({
      error: new ValidationError([
        { field: 'name', message: 'Room name must be 1 to 100 characters' },
        { field: 'memberIds[0]', message: 'memberIds[0] must be a positive integer' },
      ]),
      ok: false,
    });
  });
});

describe('AddMemberUseCase and LeaveRoomUseCase', () => {
  test('a member adds a user and the key epoch rotates', async () => {
    const room = await duo();
    const updated = valueOf(await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId: CAROL }));
    expect(updated.memberIds).toEqual([ALICE, BOB, CAROL]);
    expect(updated.keyEpoch).toBe(room.keyEpoch + 1);
  });

  test('a non-member cannot add users, and an unknown room looks the same', async () => {
    const room = await duo();
    const forbidden = { error: new ForbiddenError('You are not a member of this room'), ok: false as const };
    expect(await new AddMemberUseCase(rooms).execute(MALLORY, room.id, { userId: MALLORY })).toEqual(forbidden);
    expect(await new AddMemberUseCase(rooms).execute(ALICE, uuidV7Bound(1, 'min'), { userId: CAROL })).toEqual(
      forbidden,
    );
  });

  test('a member leaves a room of 3 and the epoch rotates; the last 2 cannot leave', async () => {
    const room = await duo();
    await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId: CAROL });
    const left = valueOf(await new LeaveRoomUseCase(rooms).execute(CAROL, room.id));
    expect(left.memberIds).toEqual([ALICE, BOB]);
    expect(await new LeaveRoomUseCase(rooms).execute(BOB, room.id)).toEqual({
      error: new ConflictError('A room needs at least 2 members'),
      ok: false,
    });
  });

  test('ListRoomsUseCase returns only the rooms the user belongs to', async () => {
    const room = await duo();
    expect(valueOf(await new ListRoomsUseCase(rooms).execute(BOB)).map((summary) => summary.id)).toEqual([room.id]);
    expect(valueOf(await new ListRoomsUseCase(rooms).execute(MALLORY))).toEqual([]);
  });
});

describe('SendMessageUseCase', () => {
  test('stores the payload with a server id and timestamp', async () => {
    const room = await duo();
    const sent = valueOf(
      await new SendMessageUseCase(rooms, messages).execute(ALICE, sendInput(room.id, room.keyEpoch)),
    );
    expect(sent.duplicate).toBe(false);
    expect(sent.message.senderId).toBe(ALICE);
    expect(sent.message.ciphertext).toBe('AQID');
    expect(Date.parse(sent.message.createdAt)).not.toBeNaN();
  });

  test('ignores any client-supplied id or timestamp', async () => {
    const room = await duo();
    const sent = valueOf(
      await new SendMessageUseCase(rooms, messages).execute(
        ALICE,
        sendInput(room.id, room.keyEpoch, { createdAt: '1999-01-01T00:00:00.000Z', id: uuidV7Bound(1, 'min') }),
      ),
    );
    expect(sent.message.id).not.toBe(uuidV7Bound(1, 'min'));
    expect(sent.message.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  test('a retry with the same idempotency key returns the original message', async () => {
    const room = await duo();
    const input = sendInput(room.id, room.keyEpoch);
    const useCase = new SendMessageUseCase(rooms, messages);
    const first = valueOf(await useCase.execute(ALICE, input));
    const retry = valueOf(await useCase.execute(ALICE, input));
    expect(retry).toEqual({ duplicate: true, message: first.message });
    expect(messages.messages).toHaveLength(1);
  });

  test('a retry still succeeds after the key epoch rotated', async () => {
    const room = await duo();
    const input = sendInput(room.id, room.keyEpoch);
    const useCase = new SendMessageUseCase(rooms, messages);
    valueOf(await useCase.execute(ALICE, input));
    await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId: CAROL });
    expect(valueOf(await useCase.execute(ALICE, input)).duplicate).toBe(true);
  });

  test('reusing an idempotency key in another room is a conflict', async () => {
    const first = await duo();
    const second = await duo();
    const key = crypto.randomUUID();
    const useCase = new SendMessageUseCase(rooms, messages);
    valueOf(await useCase.execute(ALICE, sendInput(first.id, first.keyEpoch, { idempotencyKey: key })));
    expect(await useCase.execute(ALICE, sendInput(second.id, second.keyEpoch, { idempotencyKey: key }))).toEqual({
      error: new ConflictError('idempotencyKey was already used for another message'),
      ok: false,
    });
  });

  test('a non-member cannot write to a room', async () => {
    const room = await duo();
    expect(await new SendMessageUseCase(rooms, messages).execute(MALLORY, sendInput(room.id, room.keyEpoch))).toEqual({
      error: new ForbiddenError('You are not a member of this room'),
      ok: false,
    });
    expect(messages.messages).toHaveLength(0);
  });

  test('a stale key epoch is rejected', async () => {
    const room = await duo();
    const result = await new SendMessageUseCase(rooms, messages).execute(ALICE, sendInput(room.id, room.keyEpoch - 1));
    expect(result).toEqual({
      error: new ConflictError(`Sender key epoch is stale; rotate to epoch ${room.keyEpoch}`),
      ok: false,
    });
  });

  test('a malformed payload is a validation error listing each field', async () => {
    const room = await duo();
    const result = await new SendMessageUseCase(rooms, messages).execute(
      ALICE,
      sendInput(room.id, room.keyEpoch, { idempotencyKey: 'x', iv: zeros(8) }),
    );
    expect(result).toEqual({
      error: new ValidationError([
        { field: 'idempotencyKey', message: 'idempotencyKey must be a UUID' },
        { field: 'iv', message: 'iv must be 12 bytes of base64' },
      ]),
      ok: false,
    });
  });
});

describe('HistoryUseCase', () => {
  test('pages newest first and returns a cursor while older messages remain', async () => {
    const { ids, roomId } = await seed(5);
    const history = new HistoryUseCase(rooms, messages);
    const first = valueOf(await history.execute(BOB, roomId, { limit: '2' }));
    expect(first.messages.map((message) => message.id)).toEqual([ids[4] ?? '', ids[3] ?? '']);
    expect(first.nextBefore).toBe(ids[3] ?? null);
    const last = valueOf(await history.execute(BOB, roomId, { before: ids[1] ?? null, limit: '2' }));
    expect(last.messages.map((message) => message.id)).toEqual([ids[0] ?? '']);
    expect(last.nextBefore).toBeNull();
  });

  test('filters by a server time window', async () => {
    const { roomId } = await seed(3);
    const [, middle] = messages.messages;
    const at = middle?.createdAt.toISOString() ?? '';
    const page = valueOf(await new HistoryUseCase(rooms, messages).execute(BOB, roomId, { since: at, until: at }));
    expect(page.messages).toEqual([]);
    const until = new Date((middle?.createdAt.getTime() ?? 0) + 1).toISOString();
    const window = valueOf(await new HistoryUseCase(rooms, messages).execute(BOB, roomId, { since: at, until }));
    expect(window.messages.map((message) => message.id)).toEqual([middle?.id ?? '']);
  });

  test('a non-member cannot read a room', async () => {
    const { roomId } = await seed(1);
    expect(await new HistoryUseCase(rooms, messages).execute(MALLORY, roomId, {})).toEqual({
      error: new ForbiddenError('You are not a member of this room'),
      ok: false,
    });
  });

  test('rejects an invalid limit or time', async () => {
    const { roomId } = await seed(1);
    const result = await new HistoryUseCase(rooms, messages).execute(BOB, roomId, { limit: '500', since: 'yesterday' });
    expect(result).toEqual({
      error: new ValidationError([
        { field: 'limit', message: 'limit must be an integer from 1 to 100' },
        { field: 'since', message: 'since must be an ISO 8601 date' },
      ]),
      ok: false,
    });
  });
});

describe('ReceiptUseCase', () => {
  test('advances the reader watermark and reports both watermarks', async () => {
    const room = await duo();
    const sent = valueOf(
      await new SendMessageUseCase(rooms, messages).execute(ALICE, sendInput(room.id, room.keyEpoch)),
    );
    const useCase = new ReceiptUseCase(rooms, messages, receipts);
    const marks = valueOf(await useCase.execute(BOB, { kind: 'read', messageId: sent.message.id, roomId: room.id }));
    expect(marks).toEqual({ delivered: sent.message.id, read: sent.message.id, roomId: room.id, userId: BOB });
  });

  test('rejects a message that is not in the room', async () => {
    const room = await duo();
    const result = await new ReceiptUseCase(rooms, messages, receipts).execute(BOB, {
      kind: 'delivered',
      messageId: uuidV7Bound(Date.now() + 1e9, 'max'),
      roomId: room.id,
    });
    expect(result).toEqual({ error: new NotFoundError('Message not found in this room'), ok: false });
  });

  test('a non-member cannot send receipts', async () => {
    const room = await duo();
    const sent = valueOf(
      await new SendMessageUseCase(rooms, messages).execute(ALICE, sendInput(room.id, room.keyEpoch)),
    );
    const result = await new ReceiptUseCase(rooms, messages, receipts).execute(MALLORY, {
      kind: 'read',
      messageId: sent.message.id,
      roomId: room.id,
    });
    expect(result.ok).toBe(false);
  });

  test('rejects an unknown receipt kind', async () => {
    const room = await duo();
    const result = await new ReceiptUseCase(rooms, messages, receipts).execute(BOB, {
      kind: 'seen',
      messageId: uuidV7Bound(1, 'min'),
      roomId: room.id,
    });
    expect(result).toEqual({
      error: new ValidationError([{ field: 'kind', message: 'kind must be delivered or read' }]),
      ok: false,
    });
  });
});

describe('identity and sender keys', () => {
  test('a member reads the identity keys of the room members that published one', async () => {
    const room = await duo();
    valueOf(await new PublishIdentityKeyUseCase(keys).execute(BOB, { publicKey: zeros(32) }));
    const views = valueOf(await new ListRoomKeysUseCase(rooms, keys).execute(ALICE, room.id));
    expect(views).toEqual([{ publicKey: zeros(32), userId: BOB }]);
    expect(await okOf(new ListRoomKeysUseCase(rooms, keys).execute(MALLORY, room.id))).toBe(false);
  });

  test('a member lists the names of the room members; a non-member is refused like a missing room', async () => {
    const room = await duo();
    const directory = new InMemoryMemberDirectory(
      new Map([
        [ALICE, 'alice'],
        [BOB, 'bob'],
        [MALLORY, 'mallory'],
      ]),
    );

    const members = valueOf(await new ListRoomMembersUseCase(rooms, directory).execute(BOB, room.id));
    const refused = await new ListRoomMembersUseCase(rooms, directory).execute(MALLORY, room.id);

    expect(members).toEqual([
      { id: ALICE, name: 'alice' },
      { id: BOB, name: 'bob' },
    ]);
    expect(refused.ok ? undefined : refused.error).toBeInstanceOf(ForbiddenError);
  });

  test('rejects an identity key that is not 32 bytes', async () => {
    expect(await okOf(new PublishIdentityKeyUseCase(keys).execute(BOB, { publicKey: zeros(16) }))).toBe(false);
  });

  test('a member stores envelopes for members of the current epoch, and only the recipient fetches them', async () => {
    const room = await duo();
    const stored = await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
      envelopes: [envelope(ALICE), envelope(BOB)],
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });
    expect(valueOf(stored)).toEqual({ keyEpoch: room.keyEpoch, stored: 2 });
    const fetched = valueOf(await new FetchSenderKeysUseCase(rooms, senderKeys).execute(BOB, room.id, {}));
    expect(fetched.map((view) => [view.senderId, view.recipientId])).toEqual([[ALICE, BOB]]);
    expect(await okOf(new FetchSenderKeysUseCase(rooms, senderKeys).execute(MALLORY, room.id, {}))).toBe(false);
  });

  test('envelopes for a non-member, a stale epoch, or a repeated recipient are rejected', async () => {
    const room = await duo();
    const store = new StoreSenderKeysUseCase(rooms, senderKeys);
    expect(
      await store.execute(ALICE, { envelopes: [envelope(MALLORY)], keyEpoch: room.keyEpoch, roomId: room.id }),
    ).toEqual({
      error: new ValidationError([
        { field: 'envelopes[0].recipientId', message: 'Recipient is not a member of this room' },
      ]),
      ok: false,
    });
    expect(
      await okOf(store.execute(ALICE, { envelopes: [envelope(BOB)], keyEpoch: room.keyEpoch - 1, roomId: room.id })),
    ).toBe(false);
    expect(
      await okOf(
        store.execute(ALICE, {
          envelopes: [envelope(BOB), envelope(BOB)],
          keyEpoch: room.keyEpoch,
          roomId: room.id,
        }),
      ),
    ).toBe(false);
    expect(senderKeys.envelopes).toHaveLength(0);
  });
});
