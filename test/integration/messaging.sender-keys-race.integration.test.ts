import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { SenderKeyEnvelope } from '../../src/backend/messaging/domain/messaging.message.entity.ts';
import type { UserId } from '../../src/backend/user/domain/user.value-objects.ts';

import { StoreSenderKeysUseCase } from '../../src/backend/messaging/application/messaging.keys.use-case.ts';
import { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  EncryptedPayload,
  type KeyEpoch,
  RoomName,
  X25519PublicKey,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import { PostgresSenderKeyRepository } from '../../src/backend/messaging/infrastructure/messaging.keys.postgresql.ts';
import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { ConflictError, ForbiddenError } from '../../src/backend/shared/domain/app.error.ts';
import {
  type IsolatedDatabase,
  isolatedDatabase,
  StaleRoomRepository,
} from '../support/messaging.database.test-support.ts';

// BUG-CRITICAL-02: a join or leave that commits between the use case's in-memory checks and the
// INSERT must end as a Result error (no unhandled 23503, no 500) and must never store envelopes
// for an epoch the room already rotated past.

let database: IsolatedDatabase;
let rooms: StaleRoomRepository;
let senderKeys: PostgresSenderKeyRepository;

beforeAll(async () => {
  database = await isolatedDatabase(4);
  rooms = new StaleRoomRepository(database.db);
  senderKeys = new PostgresSenderKeyRepository(database.db);
});

afterAll(async () => {
  await database.close();
});

function envelope(room: Room, keyEpoch: KeyEpoch, sender: UserId, recipient: UserId): SenderKeyEnvelope {
  return {
    ephemeralPublicKey: X25519PublicKey.restore(new Uint8Array(32).fill(1)),
    keyEpoch,
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(16),
      ciphertext: new Uint8Array(32).fill(2),
      iv: new Uint8Array(12),
    }),
    recipientId: recipient,
    roomId: room.id,
    senderId: sender,
  };
}

async function fourMemberRoom(): Promise<Room> {
  const { user } = database;
  const draft = Room.draft({
    creator: user(0),
    memberIds: [user(1), user(2), user(3)],
    name: RoomName.restore('Team'),
  });
  if (!draft.ok) {
    throw draft.error;
  }
  return rooms.create(draft.value);
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  return null;
}

async function storedFor(room: Room): Promise<number> {
  const [row] = await database.db<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM sender_key_envelopes WHERE room_id = ${room.id}
  `;
  return row?.count ?? -1;
}

async function threeMemberRoom(): Promise<Room> {
  const { user } = database;
  const draft = Room.draft({
    creator: user(0),
    memberIds: [user(1), user(2)],
    name: RoomName.restore('Team'),
  });
  if (!draft.ok) {
    throw draft.error;
  }
  return rooms.create(draft.value);
}

function wire(recipientId: UserId): Record<string, unknown> {
  return {
    authTag: bytes(16),
    ciphertext: bytes(32),
    ephemeralPublicKey: bytes(32),
    iv: bytes(12),
    recipientId,
  };
}

/** Base64 of `length` bytes set to 1. */
function bytes(length: number): string {
  return new Uint8Array(length).fill(1).toBase64();
}

describe('StoreSenderKeysUseCase under concurrent membership changes', () => {
  test('a recipient who left mid-request yields a stale-epoch conflict result, not a 500', async () => {
    const { user } = database;
    const room = await threeMemberRoom();
    const shrunk = await rooms.removeMember(room.id, user(2));
    rooms.freeze(room);
    const useCase = new StoreSenderKeysUseCase(rooms, senderKeys);

    const result = await useCase.execute(user(0), {
      envelopes: [wire(user(1)), wire(user(2))],
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });

    expect(result).toEqual({
      error: new ConflictError(`Sender key epoch is stale; rotate to epoch ${shrunk.keyEpoch}`),
      ok: false,
    });
    expect(await storedFor(room)).toBe(0);
  });

  test('a member who joined mid-request leaves no envelopes stored for the stale epoch', async () => {
    const { user } = database;
    const room = await threeMemberRoom();
    const grown = await rooms.addMember(room.id, user(3));
    rooms.freeze(room);
    const useCase = new StoreSenderKeysUseCase(rooms, senderKeys);

    const result = await useCase.execute(user(0), {
      envelopes: [wire(user(1)), wire(user(2))],
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });

    expect(result).toEqual({
      error: new ConflictError(`Sender key epoch is stale; rotate to epoch ${grown.keyEpoch}`),
      ok: false,
    });
    expect(await storedFor(room)).toBe(0);
  });

  test('without a concurrent change the envelopes are stored for the current epoch', async () => {
    const { user } = database;
    const room = await threeMemberRoom();
    const useCase = new StoreSenderKeysUseCase(rooms, senderKeys);

    const result = await useCase.execute(user(0), {
      envelopes: [wire(user(1)), wire(user(2))],
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });

    expect(result).toEqual({ ok: true, value: { keyEpoch: room.keyEpoch, stored: 2 } });
    expect(await senderKeys.forRecipient(room.id, user(2), room.keyEpoch)).toHaveLength(1);
  });
});

describe('PostgresSenderKeyRepository.store racing a real leave', () => {
  // Verifier blocker B1: store() and removeMember() on two connections must never deadlock (40P01).
  test('neither side deadlocks, and the outcome is consistent', async () => {
    const { user } = database;
    const leaver = new PostgresRoomRepository(await database.reserve());
    for (let round = 0; round < 25; round += 1) {
      // Sequential rounds on purpose: each one is its own race.
      // eslint-disable-next-line no-await-in-loop
      const room = await fourMemberRoom();
      // eslint-disable-next-line no-await-in-loop
      const [left, stored] = await Promise.allSettled([
        leaver.removeMember(room.id, user(3)),
        senderKeys.store([
          envelope(room, room.keyEpoch, user(0), user(1)),
          envelope(room, room.keyEpoch, user(0), user(3)),
        ]),
      ]);
      expect(left.status).toBe('fulfilled');
      if (stored.status === 'rejected') {
        expect(stored.reason).toEqual(
          new ConflictError(`Sender key epoch is stale; rotate to epoch ${room.keyEpoch + 1}`),
        );
        // eslint-disable-next-line no-await-in-loop
        expect(await storedFor(room)).toBe(0);
      } else {
        // Stored first; the leave then cascades the leaver's envelope away.
        // eslint-disable-next-line no-await-in-loop
        expect(await senderKeys.forRecipient(room.id, user(1), room.keyEpoch)).toHaveLength(1);
        // eslint-disable-next-line no-await-in-loop
        expect(await senderKeys.forRecipient(room.id, user(3), room.keyEpoch)).toEqual([]);
      }
    }
  }, 120_000);
});

describe('PostgresSenderKeyRepository.store foreign keys', () => {
  test('maps a recipient who is not a member to a conflict and stores nothing', async () => {
    const { user } = database;
    const room = await threeMemberRoom();

    const rejection = await rejectionOf(
      senderKeys.store([
        envelope(room, room.keyEpoch, user(0), user(1)),
        envelope(room, room.keyEpoch, user(0), user(3)),
      ]),
    );

    expect(rejection).toEqual(new ConflictError('Every recipient must be a current member of this room'));
    expect(await storedFor(room)).toBe(0);
  });

  test('maps a sender who is not a member to forbidden', async () => {
    const { user } = database;
    const room = await threeMemberRoom();

    const rejection = await rejectionOf(senderKeys.store([envelope(room, room.keyEpoch, user(3), user(1))]));

    expect(rejection).toEqual(new ForbiddenError('You are not a member of this room'));
    expect(await storedFor(room)).toBe(0);
  });
});
