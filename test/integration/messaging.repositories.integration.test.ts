import type { ReservedSQL } from 'bun';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { NewMessage } from '../../src/backend/messaging/domain/messaging.message.entity.ts';

import { Room, type RoomDraft } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
  MessageId,
  type RoomId,
  RoomName,
  uuidV7Bound,
  X25519PublicKey,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import {
  PostgresKeyDirectory,
  PostgresSenderKeyRepository,
} from '../../src/backend/messaging/infrastructure/messaging.keys.postgresql.ts';
import { PostgresMessageRepository } from '../../src/backend/messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresReceiptRepository } from '../../src/backend/messaging/infrastructure/messaging.receipts.postgresql.ts';
import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/backend/shared/domain/app.error.ts';
import { UserId } from '../../src/backend/user/domain/user.value-objects.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

// Adapters run against a brand-new schema so they never see the running server's rows.

const sql = createPostgresClient({ max: 1, url: loadConfig().databaseUrl });
const schema = `schema_${crypto.randomUUID().replaceAll('-', '')}`;
let db: ReservedSQL;
let users: UserId[] = [];
let rooms: PostgresRoomRepository;
let messages: PostgresMessageRepository;
let receipts: PostgresReceiptRepository;
let keys: PostgresKeyDirectory;
let senderKeys: PostgresSenderKeyRepository;

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  db = await sql.reserve();
  await db.unsafe(`SET search_path TO "${schema}"`);
  await applyUserSchema(db);
  const rows = await db<Array<{ id: number }>>`
    INSERT INTO users (name, password) SELECT 'u' || g, 'x' FROM generate_series(1, 101) g RETURNING id
  `;
  users = rows.map((row) => UserId.restore(row.id));
  rooms = new PostgresRoomRepository(db);
  messages = new PostgresMessageRepository(db);
  receipts = new PostgresReceiptRepository(db);
  keys = new PostgresKeyDirectory(db);
  senderKeys = new PostgresSenderKeyRepository(db);
});

afterAll(async () => {
  await db.release();
  await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await sql.close();
});

function draft(memberIds: readonly UserId[]): RoomDraft {
  const result = Room.draft({ creator: user(0), memberIds, name: RoomName.restore('Team') });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function newMessage(roomId: RoomId, sender: UserId, chainIndex = 0, key = crypto.randomUUID()): NewMessage {
  return {
    chainIndex: ChainIndex.restore(chainIndex),
    idempotencyKey: IdempotencyKey.restore(key),
    keyEpoch: KeyEpoch.restore(2),
    payload: payload(),
    roomId,
    senderId: sender,
  };
}

function payload(bytes = 3): EncryptedPayload {
  return EncryptedPayload.restore({
    authTag: new Uint8Array(16),
    ciphertext: new Uint8Array(bytes).fill(7),
    iv: new Uint8Array(12),
  });
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function user(index: number): UserId {
  const id = users[index];
  if (id === undefined) {
    throw new Error(`no user ${index}`);
  }
  return id;
}

describe('PostgresRoomRepository', () => {
  test('creates a room with its members and the epoch the database assigned', async () => {
    const room = await rooms.create(draft([user(1)]));
    expect(room.memberIds).toEqual([user(0), user(1)]);
    expect(room.keyEpoch).toBe(KeyEpoch.restore(2));
    const found = await rooms.findById(room.id);
    expect(found?.toSummary()).toEqual(room.toSummary());
  });

  test('rejects members that are not users', async () => {
    const error = await rejectionOf(rooms.create(draft([UserId.restore(2_000_000_000)])));
    expect(error).toEqual(
      new ValidationError([{ field: 'memberIds', message: 'Every member must be an existing user' }]),
    );
  });

  test('adds and removes members, bumping the epoch each time', async () => {
    const room = await rooms.create(draft([user(1)]));
    const grown = await rooms.addMember(room.id, user(2));
    expect(grown.memberIds).toEqual([user(0), user(1), user(2)]);
    expect(grown.keyEpoch).toBe(KeyEpoch.restore(3));
    const shrunk = await rooms.removeMember(room.id, user(2));
    expect(shrunk.memberIds).toEqual([user(0), user(1)]);
    expect(shrunk.keyEpoch).toBe(KeyEpoch.restore(4));
  });

  test('maps the capacity triggers to conflicts', async () => {
    const room = await rooms.create(draft(users.slice(1, 100)));
    expect(await rejectionOf(rooms.addMember(room.id, user(100)))).toEqual(
      new ConflictError('A room holds at most 100 members'),
    );
    const duo = await rooms.create(draft([user(1)]));
    expect(await rejectionOf(rooms.removeMember(duo.id, user(1)))).toEqual(
      new ConflictError('A room needs at least 2 members'),
    );
  });

  test('adding a user who is already a member is a conflict, also under a race', async () => {
    const room = await rooms.create(draft([user(1)]));
    const outcomes = await Promise.allSettled([rooms.addMember(room.id, user(3)), rooms.addMember(room.id, user(3))]);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(new ConflictError('User is already a member of this room'));
  });

  test('lists only the rooms a user belongs to', async () => {
    const room = await rooms.create(draft([user(50)]));
    const listed = await rooms.listForMember(user(50));
    expect(listed.map((entry) => String(entry.id))).toContain(room.id);
    expect(await rooms.listForMember(user(100))).toEqual([]);
  });
});

describe('PostgresMessageRepository', () => {
  test('stores once per idempotency key and returns the original on a retry', async () => {
    const room = await rooms.create(draft([user(1)]));
    const message = newMessage(room.id, user(0));
    const first = await messages.append(message);
    const retry = await messages.append({ ...message, chainIndex: ChainIndex.restore(9) });
    expect(first.duplicate).toBe(false);
    expect(retry).toEqual({ duplicate: true, message: first.message });
    expect(first.message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
    expect([...first.message.draft.payload.ciphertext]).toEqual([7, 7, 7]);
    expect(await messages.findByIdempotencyKey(user(0), message.idempotencyKey)).toEqual(first.message);
    expect(await messages.exists(room.id, first.message.id)).toBe(true);
    expect(await messages.exists(room.id, uuidV7Bound(1, 'min'))).toBe(false);
  });

  test('pages newest first within exclusive bounds', async () => {
    const room = await rooms.create(draft([user(1)]));
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- each row must get a later UUIDv7
      const { message } = await messages.append(newMessage(room.id, user(0), index));
      ids.push(message.id);
    }
    const page = await messages.page(room.id, { after: null, before: null, limit: 2 });
    expect(page.map((message) => String(message.id))).toEqual([ids[3] ?? '', ids[2] ?? '']);
    const middle = await messages.page(room.id, {
      after: MessageId.restore(ids[0] ?? ''),
      before: MessageId.restore(ids[3] ?? ''),
      limit: 10,
    });
    expect(middle.map((message) => String(message.id))).toEqual([ids[2] ?? '', ids[1] ?? '']);
  });

  test('reusing a chain index within an epoch is a conflict', async () => {
    const room = await rooms.create(draft([user(1)]));
    await messages.append(newMessage(room.id, user(0), 7));
    expect(await rejectionOf(messages.append(newMessage(room.id, user(0), 7)))).toEqual(
      new ConflictError('chainIndex was already used in this key epoch; encrypt again'),
    );
  });

  test('a sender who is not a member is refused by the database', async () => {
    const room = await rooms.create(draft([user(1)]));
    expect(await rejectionOf(messages.append(newMessage(room.id, user(99))))).toEqual(
      new ForbiddenError('You are not a member of this room'),
    );
  });
});

describe('PostgresReceiptRepository', () => {
  test('watermarks only move forward and reading implies delivered', async () => {
    const room = await rooms.create(draft([user(1)]));
    const older = await messages.append(newMessage(room.id, user(0), 0));
    const newer = await messages.append(newMessage(room.id, user(0), 1));
    expect(await receipts.advance(room.id, user(1), 'read', older.message.id)).toEqual({
      delivered: older.message.id,
      read: older.message.id,
    });
    expect(await receipts.advance(room.id, user(1), 'delivered', newer.message.id)).toEqual({
      delivered: newer.message.id,
      read: older.message.id,
    });
    expect(await receipts.advance(room.id, user(1), 'delivered', older.message.id)).toEqual({
      delivered: newer.message.id,
      read: older.message.id,
    });
    const marks = await receipts.forRoom(room.id);
    expect(marks.get(user(1))).toEqual({ delivered: newer.message.id, read: older.message.id });
    expect(marks.get(user(0))).toEqual({ delivered: null, read: null });
  });
});

describe('key adapters', () => {
  test('the identity key is replaced on publish and found by user', async () => {
    await keys.publish(user(5), X25519PublicKey.restore(new Uint8Array(32).fill(1)));
    await keys.publish(user(5), X25519PublicKey.restore(new Uint8Array(32).fill(2)));
    const found = await keys.find([user(5), user(6)]);
    expect([...found.keys()]).toEqual([user(5)]);
    expect(found.get(user(5))?.toBase64()).toBe(new Uint8Array(32).fill(2).toBase64());
  });

  test('envelopes are upserted, read per recipient, and removed when the recipient leaves', async () => {
    const room = await rooms.create(draft([user(1), user(2)]));
    const envelope = {
      ephemeralPublicKey: X25519PublicKey.restore(new Uint8Array(32)),
      keyEpoch: room.keyEpoch,
      payload: payload(48),
      recipientId: user(2),
      roomId: room.id,
      senderId: user(0),
    };
    await senderKeys.store([envelope]);
    await senderKeys.store([{ ...envelope, payload: payload(40) }]);
    const stored = await senderKeys.forRecipient(room.id, user(2), room.keyEpoch);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload.ciphertext).toHaveLength(40);
    await rooms.removeMember(room.id, user(2));
    expect(await senderKeys.forRecipient(room.id, user(2), room.keyEpoch)).toEqual([]);
  });
});
