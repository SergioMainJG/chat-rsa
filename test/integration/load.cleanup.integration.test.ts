import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  RoomName,
  X25519PublicKey,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import {
  PostgresKeyDirectory,
  PostgresSenderKeyRepository,
} from '../../src/backend/messaging/infrastructure/messaging.keys.postgresql.ts';
import { PostgresMessageRepository } from '../../src/backend/messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { UserId } from '../../src/backend/user/domain/user.value-objects.ts';
import { newRunId } from '../load/k6-runner.ts';
import { deleteRunData } from '../load/load.cleanup.ts';
import { type IsolatedDatabase, isolatedDatabase } from '../support/messaging.database.test-support.ts';

// BUG-CRITICAL-02 (load run 2): once load users touched messaging, `DELETE FROM users` failed on
// rooms_created_by_fkey, messages_sender_id_fkey and the deferred rooms_min_members check. The
// cleanup must remove everything a run created, and nothing else.

let database: IsolatedDatabase;
let rooms: PostgresRoomRepository;
let messages: PostgresMessageRepository;

beforeAll(async () => {
  database = await isolatedDatabase(3);
  rooms = new PostgresRoomRepository(database.db);
  messages = new PostgresMessageRepository(database.db);
});

afterAll(async () => {
  await database.close();
});

async function count(table: string): Promise<number> {
  const [row] = await database.db.unsafe<Array<{ count: number }>>(`SELECT count(*)::int AS count FROM ${table}`);
  return row?.count ?? -1;
}

async function membersOf(room: Room): Promise<readonly UserId[] | undefined> {
  const found = await rooms.findById(room.id);
  return found?.memberIds;
}

async function roomOf(creator: UserId, others: readonly UserId[]): Promise<Room> {
  const draft = Room.draft({ creator, memberIds: others, name: RoomName.restore('Load') });
  if (!draft.ok) {
    throw draft.error;
  }
  return rooms.create(draft.value);
}

async function send(room: Room, sender: UserId): Promise<void> {
  const current = await rooms.findById(room.id);
  await messages.append({
    chainIndex: ChainIndex.restore(Math.floor(Math.random() * 1e6)),
    idempotencyKey: IdempotencyKey.restore(crypto.randomUUID()),
    keyEpoch: current?.keyEpoch ?? room.keyEpoch,
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(16),
      ciphertext: new Uint8Array(3).fill(7),
      iv: new Uint8Array(12),
    }),
    roomId: room.id,
    senderId: sender,
  });
}

async function usersOf(runId: string, kinds: readonly string[]): Promise<UserId[]> {
  const names = kinds.map((kind) => `load${runId}${kind}`);
  const rows = await database.db<Array<{ id: number }>>`
    INSERT INTO users (name, password) SELECT unnest(${names}::text[]), 'x' RETURNING id
  `;
  return rows.map((row) => UserId.restore(row.id));
}

describe('deleteRunData', () => {
  test('removes rooms, messages, keys and users a run created, even after messaging traffic', async () => {
    const runId = newRunId();
    const [a, b, c] = await usersOf(runId, ['m0', 'm1', 'm2']);
    if (!a || !b || !c) {
      throw new Error('users not created');
    }
    const keys = new PostgresKeyDirectory(database.db);
    await keys.publish(a, X25519PublicKey.restore(new Uint8Array(32).fill(1)));
    const created = await roomOf(a, [b]);
    await send(created, a);
    await send(created, b);
    const joined = await roomOf(b, [c]);
    await send(joined, c);
    await new PostgresSenderKeyRepository(database.db).store([
      {
        ephemeralPublicKey: X25519PublicKey.restore(new Uint8Array(32).fill(2)),
        keyEpoch: created.keyEpoch,
        payload: EncryptedPayload.restore({
          authTag: new Uint8Array(16),
          ciphertext: new Uint8Array(32),
          iv: new Uint8Array(12),
        }),
        recipientId: b,
        roomId: created.id,
        senderId: a,
      },
    ]);

    const removed = await deleteRunData(database.db, runId);

    expect(removed).toEqual({ rooms: 2, users: 3 });
    const left = await database.db<Array<{ id: number }>>`SELECT id FROM users WHERE name LIKE ${`load${runId}%`}`;
    expect(left).toHaveLength(0);
    expect(await rooms.findById(created.id)).toBeNull();
    expect(await rooms.findById(joined.id)).toBeNull();
  });

  test('leaves every other user, room and message untouched', async () => {
    const runId = newRunId();
    const { user } = database;
    const foreignRoom = await roomOf(user(0), [user(1)]);
    await send(foreignRoom, user(0));
    const [a, b] = await usersOf(runId, ['m0', 'p0']);
    if (!a || !b) {
      throw new Error('users not created');
    }
    await roomOf(a, [b]);
    const before = { messages: await count('messages'), rooms: await count('rooms'), users: await count('users') };

    const removed = await deleteRunData(database.db, runId);

    expect(removed).toEqual({ rooms: 1, users: 2 });
    expect(await count('users')).toBe(before.users - 2);
    expect(await count('rooms')).toBe(before.rooms - 1);
    expect(await count('messages')).toBe(before.messages);
    expect(await membersOf(foreignRoom)).toEqual([user(0), user(1)]);
  });

  test('a run member of someone else’s room leaves it: its own messages go, the room stays', async () => {
    const runId = newRunId();
    const { user } = database;
    const [a] = await usersOf(runId, ['m0']);
    if (!a) {
      throw new Error('user not created');
    }
    const mixed = await roomOf(user(0), [user(1), a]);
    await send(mixed, a);
    await send(mixed, user(1));

    const removed = await deleteRunData(database.db, runId);

    expect(removed).toEqual({ rooms: 0, users: 1 });
    expect(await membersOf(mixed)).toEqual([user(0), user(1)]);
    const [senders] = await database.db<Array<{ senders: number[] }>>`
      SELECT array_agg(DISTINCT sender_id) AS senders FROM messages WHERE room_id = ${mixed.id}
    `;
    expect([...(senders?.senders ?? [])]).toEqual([user(1)]);
  });

  test('a room a run user created is deleted even when foreign users joined it', async () => {
    const runId = newRunId();
    const { user } = database;
    const [a] = await usersOf(runId, ['m0']);
    if (!a) {
      throw new Error('user not created');
    }
    const owned = await roomOf(a, [user(0), user(1)]);
    await send(owned, user(0));

    const removed = await deleteRunData(database.db, runId);

    expect(removed).toEqual({ rooms: 1, users: 1 });
    expect(await rooms.findById(owned.id)).toBeNull();
    const foreign = await database.db<
      Array<{ id: number }>
    >`SELECT id FROM users WHERE id IN ${database.db([user(0), user(1)])}`;
    expect(foreign).toHaveLength(2);
  });

  test('refuses to shrink someone else’s room below two members, and changes nothing', async () => {
    const runId = newRunId();
    const { user } = database;
    const [a] = await usersOf(runId, ['m0']);
    if (!a) {
      throw new Error('user not created');
    }
    const pair = await roomOf(user(2), [a]);
    await send(pair, a);
    const before = { messages: await count('messages'), rooms: await count('rooms'), users: await count('users') };

    let rejection: unknown = null;
    try {
      await deleteRunData(database.db, runId);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toContain('minimum is 2');
    expect({ messages: await count('messages'), rooms: await count('rooms'), users: await count('users') }).toEqual(
      before,
    );
    expect(await membersOf(pair)).toEqual([user(2), a]);
  });

  test('a run that created nothing removes nothing', async () => {
    expect(await deleteRunData(database.db, newRunId())).toEqual({ rooms: 0, users: 0 });
  });

  test('refuses a malformed runId before touching the database', async () => {
    const before = await count('users');
    let rejection: unknown = null;
    try {
      await deleteRunData(database.db, '.*|x');
    } catch (error) {
      rejection = error;
    }
    expect(String(rejection)).toContain('Refusing to build a delete pattern');
    expect(await count('users')).toBe(before);
  });
});
