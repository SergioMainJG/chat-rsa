import type { ReservedSQL } from 'bun';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { SendMessageUseCase } from '../../src/backend/messaging/application/messaging.send-message.use-case.ts';
import { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
  type RoomId,
  RoomName,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import { PostgresMessageRepository } from '../../src/backend/messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { ConflictError } from '../../src/backend/shared/domain/app.error.ts';
import { UserId, type UserId as UserIdType } from '../../src/backend/user/domain/user.value-objects.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

// BUG-CRITICAL-01: one idempotency key reused across two rooms must never hand room A's message to
// room B, and the database must refuse a message under a key epoch the room already rotated past.

const sql = createPostgresClient({ max: 1, url: loadConfig().databaseUrl });
const schema = `schema_${crypto.randomUUID().replaceAll('-', '')}`;
const REUSED_KEY = 'idempotencyKey was already used for another message';
let db: ReservedSQL;
let users: UserIdType[] = [];
let rooms: PostgresRoomRepository;
let messages: PostgresMessageRepository;

/** Answers the use case's first lookup with `null`, as if the other request had not committed yet. */
class StaleFirstReadRepository extends PostgresMessageRepository {
  private stale = true;

  override async findByIdempotencyKey(
    senderId: UserIdType,
    key: IdempotencyKey,
  ): ReturnType<PostgresMessageRepository['findByIdempotencyKey']> {
    if (this.stale) {
      this.stale = false;
      return null;
    }
    return super.findByIdempotencyKey(senderId, key);
  }
}

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  db = await sql.reserve();
  await db.unsafe(`SET search_path TO "${schema}"`);
  await applyUserSchema(db);
  const rows = await db<Array<{ id: number }>>`
    INSERT INTO users (name, password) SELECT 'u' || g, 'x' FROM generate_series(1, 3) g RETURNING id
  `;
  users = rows.map((row) => UserId.restore(row.id));
  rooms = new PostgresRoomRepository(db);
  messages = new PostgresMessageRepository(db);
});

afterAll(async () => {
  await db.release();
  await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await sql.close();
});

async function countIn(roomId: RoomId): Promise<number> {
  const [row] = await db<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM messages WHERE room_id = ${roomId}
  `;
  return row?.count ?? -1;
}

function rawMessage(roomId: RoomId, keyEpoch: number): Parameters<PostgresMessageRepository['append']>[0] {
  return {
    chainIndex: ChainIndex.restore(0),
    idempotencyKey: IdempotencyKey.restore(crypto.randomUUID()),
    keyEpoch: KeyEpoch.restore(keyEpoch),
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(16),
      ciphertext: new Uint8Array(3).fill(7),
      iv: new Uint8Array(12),
    }),
    roomId,
    senderId: user(0),
  };
}

async function roomOf(...others: number[]): Promise<Room> {
  const draft = Room.draft({
    creator: user(0),
    memberIds: others.map((index) => user(index)),
    name: RoomName.restore('Team'),
  });
  if (!draft.ok) {
    throw draft.error;
  }
  return rooms.create(draft.value);
}

function sendInput(room: Room, idempotencyKey: string, chainIndex = 0): Record<string, unknown> {
  return {
    authTag: bytes(16),
    chainIndex,
    ciphertext: bytes(4),
    idempotencyKey,
    iv: bytes(12),
    keyEpoch: room.keyEpoch,
    roomId: room.id,
  };
}

function user(index: number): UserIdType {
  const id = users[index];
  if (id === undefined) {
    throw new Error(`no user ${index}`);
  }
  return id;
}

/** Base64 of `length` bytes set to 1. */
function bytes(length: number): string {
  return new Uint8Array(length).fill(1).toBase64();
}

describe('SendMessageUseCase idempotency across rooms', () => {
  test('two concurrent sends with one key to two rooms never return the other room’s message', async () => {
    const [roomA, roomB] = await Promise.all([roomOf(1), roomOf(2)]);
    const send = new SendMessageUseCase(rooms, messages);
    const key = crypto.randomUUID();

    const [resA, resB] = await Promise.all([
      send.execute(user(0), sendInput(roomA, key)),
      send.execute(user(0), sendInput(roomB, key)),
    ]);

    const results = [
      { result: resA, target: roomA.id },
      { result: resB, target: roomB.id },
    ];
    for (const { result, target } of results) {
      if (result.ok) {
        expect(result.value.message.roomId).toBe(target);
      } else {
        expect(result.error).toEqual(new ConflictError(REUSED_KEY));
      }
    }
    expect(results.filter(({ result }) => result.ok)).toHaveLength(1);
    expect((await countIn(roomA.id)) + (await countIn(roomB.id))).toBe(1);
  });

  test('a send whose lookup missed a just-committed row of another room is a conflict', async () => {
    const [roomA, roomB] = await Promise.all([roomOf(1), roomOf(2)]);
    const key = crypto.randomUUID();
    const first = await new SendMessageUseCase(rooms, messages).execute(user(0), sendInput(roomA, key));
    expect(first.ok).toBe(true);

    const racing = new SendMessageUseCase(rooms, new StaleFirstReadRepository(db));
    const second = await racing.execute(user(0), sendInput(roomB, key));

    expect(second).toEqual({ error: new ConflictError(REUSED_KEY), ok: false });
    expect(await countIn(roomA.id)).toBe(1);
    expect(await countIn(roomB.id)).toBe(0);
  });

  test('the same race inside one room is still answered with the stored original', async () => {
    const room = await roomOf(1);
    const key = crypto.randomUUID();
    const first = await new SendMessageUseCase(rooms, messages).execute(user(0), sendInput(room, key));
    if (!first.ok) {
      throw first.error;
    }

    const racing = new SendMessageUseCase(rooms, new StaleFirstReadRepository(db));
    const retry = await racing.execute(user(0), sendInput(room, key));

    expect(retry).toEqual({ ok: true, value: { duplicate: true, message: first.value.message } });
    expect(await countIn(room.id)).toBe(1);
  });
});

describe('messages key epoch guard', () => {
  test('the database refuses a message under a rotated key epoch', async () => {
    const room = await roomOf(1);
    const grown = await rooms.addMember(room.id, user(2));
    expect(grown.keyEpoch).toBe(KeyEpoch.restore(room.keyEpoch + 1));

    let rejection: unknown = null;
    try {
      await messages.append(rawMessage(room.id, room.keyEpoch));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(new ConflictError(`Sender key epoch is stale; rotate to epoch ${grown.keyEpoch}`));
    expect(await countIn(room.id)).toBe(0);
  });

  test('the current key epoch is still accepted', async () => {
    const room = await roomOf(1);
    const grown = await rooms.addMember(room.id, user(2));

    const outcome = await messages.append(rawMessage(room.id, grown.keyEpoch));

    expect(outcome.duplicate).toBe(false);
    expect(outcome.message.toView().keyEpoch).toBe(grown.keyEpoch);
    expect(await countIn(room.id)).toBe(1);
  });
});
