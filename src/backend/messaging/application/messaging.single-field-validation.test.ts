import { beforeEach, describe, expect, test } from 'bun:test';

import { ValidationError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { KeyEpoch, RoomId } from '../domain/messaging.value-objects.ts';
import {
  InMemoryMessageRepository,
  InMemoryRoomRepository,
  InMemorySenderKeyRepository,
  zeros,
} from './messaging.fakes.test-support.ts';
import { HistoryUseCase } from './messaging.history.use-case.ts';
import { FetchSenderKeysUseCase, StoreSenderKeysUseCase } from './messaging.keys.use-case.ts';
import { AddMemberUseCase, CreateRoomUseCase, LeaveRoomUseCase } from './messaging.rooms.use-case.ts';
import { SendMessageUseCase } from './messaging.send-message.use-case.ts';

// BUG-HIGH-09: every guard must fire for one invalid field while all the others are valid, so a
// `||` turned into `&&` (or a guard turned into `false`) cannot hide behind another invalid field.

const ALICE = UserId.restore(1);
const BOB = UserId.restore(2);
const CAROL = UserId.restore(3);

let rooms: InMemoryRoomRepository;
let messages: InMemoryMessageRepository;
let senderKeys: InMemorySenderKeyRepository;

beforeEach(() => {
  rooms = new InMemoryRoomRepository();
  messages = new InMemoryMessageRepository();
  senderKeys = new InMemorySenderKeyRepository();
});

async function duo(): Promise<{ id: string; keyEpoch: number }> {
  const created = await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [BOB], name: 'Duo' });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}

function envelope(recipientId: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authTag: zeros(16),
    ciphertext: zeros(32),
    ephemeralPublicKey: zeros(32),
    iv: zeros(12),
    recipientId,
    ...overrides,
  };
}

function invalid(field: string, message: string): { error: ValidationError; ok: false } {
  return { error: new ValidationError([{ field, message }]), ok: false };
}

async function rotatedRoom(): Promise<{ id: string; oldEpoch: number }> {
  const room = await duo();
  const stored = await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
    envelopes: [envelope(BOB)],
    keyEpoch: room.keyEpoch,
    roomId: room.id,
  });
  expect(stored.ok).toBe(true);
  const added = await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId: CAROL });
  expect(added.ok && added.value.keyEpoch).toBe(room.keyEpoch + 1);
  return { id: room.id, oldEpoch: room.keyEpoch };
}

async function validSend(): Promise<Record<string, unknown>> {
  const room = await duo();
  return {
    authTag: zeros(16),
    chainIndex: 0,
    ciphertext: 'AQID',
    idempotencyKey: crypto.randomUUID(),
    iv: zeros(12),
    keyEpoch: room.keyEpoch,
    roomId: room.id,
  };
}

describe('SendMessageUseCase', () => {
  test.each([
    ['idempotencyKey', 'not-a-uuid', 'idempotencyKey must be a UUID'],
    ['keyEpoch', -1, 'keyEpoch must be an integer from 0 to 2147483647'],
    ['chainIndex', -1, 'chainIndex must be an integer from 0 to 2147483647'],
    ['ciphertext', '', 'ciphertext must be 1 to 65536 bytes of base64'],
    ['iv', zeros(11), 'iv must be 12 bytes of base64'],
    ['authTag', zeros(15), 'authTag must be 16 bytes of base64'],
  ])('only %s invalid is a ValidationError and stores nothing', async (field, value, message) => {
    const input = { ...(await validSend()), [field]: value };
    expect(await new SendMessageUseCase(rooms, messages).execute(ALICE, input)).toEqual(invalid(field, message));
    expect(messages.messages).toEqual([]);
  });

  test('the same input with every field valid is stored', async () => {
    const sent = await new SendMessageUseCase(rooms, messages).execute(ALICE, await validSend());
    expect(sent.ok).toBe(true);
    expect(messages.messages).toHaveLength(1);
  });
});

describe('CreateRoomUseCase', () => {
  test('only the name invalid', async () => {
    expect(await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [BOB], name: '   ' })).toEqual(
      invalid('name', 'Room name must be 1 to 100 characters'),
    );
    expect(rooms.rooms.size).toBe(0);
  });

  test('only the member ids invalid', async () => {
    expect(await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: 'bob', name: 'Duo' })).toEqual(
      invalid('memberIds', 'memberIds must be an array of at most 100 user ids'),
    );
    expect(await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [0], name: 'Duo' })).toEqual(
      invalid('memberIds[0]', 'memberIds[0] must be a positive integer'),
    );
    expect(rooms.rooms.size).toBe(0);
  });
});

describe('AddMemberUseCase', () => {
  test.each([0, -1, 'abc', 1.5, null])('rejects userId %j without touching the room', async (userId) => {
    const room = await duo();
    expect(await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId })).toEqual(
      invalid('userId', 'userId must be a positive integer'),
    );
    const stored = await rooms.findById(RoomId.restore(room.id));
    expect(stored?.memberIds).toEqual([ALICE, BOB]);
    expect(stored?.keyEpoch).toBe(KeyEpoch.restore(room.keyEpoch));
  });

  test('a valid userId is added', async () => {
    const room = await duo();
    const added = await new AddMemberUseCase(rooms).execute(ALICE, room.id, { userId: CAROL });
    expect(added.ok && added.value.memberIds).toEqual([ALICE, BOB, CAROL]);
  });
});

describe('FetchSenderKeysUseCase keyEpoch query', () => {
  test('an explicit historical keyEpoch returns that epoch’s envelopes', async () => {
    const room = await rotatedRoom();
    const fetched = await new FetchSenderKeysUseCase(rooms, senderKeys).execute(BOB, room.id, {
      keyEpoch: String(room.oldEpoch),
    });
    expect(fetched.ok && fetched.value.map((view) => [view.keyEpoch, view.senderId])).toEqual([[room.oldEpoch, ALICE]]);
  });

  test('without keyEpoch the current (rotated) epoch is used, which has no envelopes yet', async () => {
    const room = await rotatedRoom();
    expect(await new FetchSenderKeysUseCase(rooms, senderKeys).execute(BOB, room.id, {})).toEqual({
      ok: true,
      value: [],
    });
  });

  test.each(['-1', 'abc', '1.5'])('an invalid keyEpoch %j is a ValidationError', async (keyEpoch) => {
    const room = await rotatedRoom();
    expect(await new FetchSenderKeysUseCase(rooms, senderKeys).execute(BOB, room.id, { keyEpoch })).toEqual(
      invalid('keyEpoch', 'keyEpoch must be an integer from 0 to 2147483647'),
    );
  });
});

describe('StoreSenderKeysUseCase', () => {
  test('only keyEpoch invalid', async () => {
    const room = await duo();
    expect(
      await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
        envelopes: [envelope(BOB)],
        keyEpoch: -1,
        roomId: room.id,
      }),
    ).toEqual(invalid('keyEpoch', 'keyEpoch must be an integer from 0 to 2147483647'));
    expect(senderKeys.envelopes).toEqual([]);
  });

  test('only the envelopes list invalid', async () => {
    const room = await duo();
    expect(
      await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
        envelopes: [],
        keyEpoch: room.keyEpoch,
        roomId: room.id,
      }),
    ).toEqual(invalid('envelopes', 'envelopes must hold 1 to 100 entries'));
  });

  test.each([
    ['recipientId', { recipientId: 0 }, 'envelopes[0].recipientId must be a positive integer'],
    [
      'ephemeralPublicKey',
      { ephemeralPublicKey: zeros(31) },
      'envelopes[0].ephemeralPublicKey must be 32 bytes of base64',
    ],
  ])('only one envelope field (%s) invalid', async (part, overrides, message) => {
    const room = await duo();
    expect(
      await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
        envelopes: [envelope(BOB, overrides)],
        keyEpoch: room.keyEpoch,
        roomId: room.id,
      }),
    ).toEqual(invalid(`envelopes[0].${part}`, message));
    expect(senderKeys.envelopes).toEqual([]);
  });

  test('a recipient outside the room', async () => {
    const room = await duo();
    expect(
      await new StoreSenderKeysUseCase(rooms, senderKeys).execute(ALICE, {
        envelopes: [envelope(CAROL)],
        keyEpoch: room.keyEpoch,
        roomId: room.id,
      }),
    ).toEqual(invalid('envelopes[0].recipientId', 'Recipient is not a member of this room'));
  });
});

describe('HistoryUseCase', () => {
  test.each([
    ['limit', 'ten', 'limit must be an integer from 1 to 100'],
    ['before', 'nope', 'before must be a UUIDv7'],
    ['since', 'yesterday', 'since must be an ISO 8601 date'],
    ['until', 'tomorrow', 'until must be an ISO 8601 date'],
  ])('only %s invalid', async (field, value, message) => {
    const room = await duo();
    expect(await new HistoryUseCase(rooms, messages).execute(BOB, room.id, { [field]: value })).toEqual(
      invalid(field, message),
    );
  });
});

describe('malformed roomId', () => {
  test.each(['not-a-room', 42, null])('is a 400 ValidationError, not a 403 (%j)', async (roomId) => {
    await duo();
    const expected = invalid('roomId', 'roomId must be a UUIDv7');
    expect(expected.error.statusCode).toBe(400);
    expect(await new LeaveRoomUseCase(rooms).execute(ALICE, roomId)).toEqual(expected);
    expect(await new HistoryUseCase(rooms, messages).execute(ALICE, roomId, {})).toEqual(expected);
    expect(await new FetchSenderKeysUseCase(rooms, senderKeys).execute(ALICE, roomId, {})).toEqual(expected);
  });
});
