import type { ReservedSQL } from 'bun';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

// The messaging model is applied to a brand-new schema, so these tests never see rows or triggers
// left in `public` by the running server.

type RoomRow = { readonly key_epoch: number; readonly member_count: number };

const sql = createPostgresClient({ max: 1, url: loadConfig().databaseUrl });
const schema = `schema_${crypto.randomUUID().replaceAll('-', '')}`;
const ROOM = '00000000-0000-7000-8000-000000000001';
const IV = new Uint8Array(12);
const TAG = new Uint8Array(16);
let db: ReservedSQL;
let userIds: number[] = [];

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  db = await sql.reserve();
  await db.unsafe(`SET search_path TO "${schema}"`);
  await applyUserSchema(db);
  const rows = await db<Array<{ id: number }>>`
    INSERT INTO users (name, password)
    SELECT 'u' || g, 'x' FROM generate_series(1, 102) g
    RETURNING id
  `;
  userIds = rows.map((row) => row.id);
});

afterAll(async () => {
  await db.release();
  await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await sql.close();
});

async function insertMessage(senderIndex: number, idempotencyKey: string, chainIndex = 0): Promise<unknown[]> {
  return db<unknown[]>`
    INSERT INTO messages (room_id, sender_id, idempotency_key, key_epoch, chain_index, ciphertext, iv, auth_tag)
    VALUES (${ROOM}, ${user(senderIndex)}, ${idempotencyKey}, 2, ${chainIndex}, ${new Uint8Array([1])}, ${IV}, ${TAG})
    ON CONFLICT (sender_id, idempotency_key) DO NOTHING
    RETURNING id
  `;
}

/** The message a promise rejects with; fails the test when it resolves. */
async function rejectionOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the statement to be rejected');
}

async function room(): Promise<null | RoomRow> {
  const rows = await db<RoomRow[]>`SELECT member_count, key_epoch FROM rooms WHERE id = ${ROOM}`;
  return rows[0] ?? null;
}

/** Runs statements in one transaction so deferred constraints fire at COMMIT. */
async function transaction(run: () => Promise<unknown>): Promise<void> {
  await db.unsafe('BEGIN');
  try {
    await run();
    await db.unsafe('COMMIT');
  } catch (error) {
    await db.unsafe('ROLLBACK');
    throw error;
  }
}

function user(index: number): number {
  const id = userIds[index];
  if (id === undefined) {
    throw new Error(`no user at ${index}`);
  }
  return id;
}

describe('messaging schema', () => {
  test('applying sql/index.sql twice is a no-op', async () => {
    await applyUserSchema(db);
    expect(await room()).toBeNull();
  });

  test('a room with a single member is rejected at commit', async () => {
    const message = await rejectionOf(
      transaction(async () => {
        await db`INSERT INTO rooms (id, name, created_by) VALUES (${ROOM}, 'solo', ${user(0)})`;
        await db`INSERT INTO room_members (room_id, user_id) VALUES (${ROOM}, ${user(0)})`;
      }),
    );
    expect(message).toContain('minimum is 2');
    expect(await room()).toBeNull();
  });

  test('a room with two members commits, counts them, and bumps the key epoch per join', async () => {
    await transaction(async () => {
      await db`INSERT INTO rooms (id, name, created_by) VALUES (${ROOM}, 'duo', ${user(0)})`;
      await db`INSERT INTO room_members (room_id, user_id) VALUES (${ROOM}, ${user(0)}), (${ROOM}, ${user(1)})`;
    });
    expect(await room()).toEqual({ key_epoch: 2, member_count: 2 });
  });

  test('leaving a room that would drop below two members is rejected', async () => {
    const message = await rejectionOf(db`DELETE FROM room_members WHERE room_id = ${ROOM} AND user_id = ${user(1)}`);
    expect(message).toContain('minimum is 2');
    expect(await room()).toEqual({ key_epoch: 2, member_count: 2 });
  });

  test('a room holds 100 members and rejects the 101st', async () => {
    const rest = userIds.slice(2, 100).map((id) => ({ room_id: ROOM, user_id: id }));
    await db`INSERT INTO room_members ${db(rest)}`;
    const full = await room();
    expect(full?.member_count).toBe(100);
    const message = await rejectionOf(db`INSERT INTO room_members (room_id, user_id) VALUES (${ROOM}, ${user(100)})`);
    expect(message).toContain('rooms_max_members');
    const after = await room();
    expect(after?.member_count).toBe(100);
  });

  test('a member leaving bumps the key epoch', async () => {
    const before = await room();
    await db`DELETE FROM room_members WHERE room_id = ${ROOM} AND user_id = ${user(99)}`;
    const after = await room();
    expect(after?.member_count).toBe(99);
    expect(after?.key_epoch).toBe((before?.key_epoch ?? 0) + 1);
  });

  test('a retried idempotency key stores one row with a server-generated UUIDv7 and timestamp', async () => {
    const key = crypto.randomUUID();
    const first = await insertMessage(0, key);
    const retry = await insertMessage(0, key, 1);
    expect(first).toHaveLength(1);
    expect(retry).toHaveLength(0);
    const stored = await db<Array<{ created_at: Date; version: number }>>`
      SELECT uuid_extract_version(id) AS version, created_at FROM messages WHERE idempotency_key = ${key}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.version).toBe(7);
    expect(Math.abs((stored[0]?.created_at.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  test('a sender cannot reuse a chain index within one key epoch', async () => {
    await insertMessage(1, crypto.randomUUID(), 5);
    const message = await rejectionOf(insertMessage(1, crypto.randomUUID(), 5));
    expect(message).toContain('messages_chain_uq');
  });

  test('a non-member cannot write to a room', async () => {
    const message = await rejectionOf(insertMessage(101, crypto.randomUUID()));
    expect(message).toContain('is not a member');
  });

  test('a read watermark cannot run ahead of the delivered watermark', async () => {
    const message = await rejectionOf(
      db`UPDATE room_members SET last_read_message_id = ${crypto.randomUUID()} WHERE room_id = ${ROOM} AND user_id = ${user(0)}`,
    );
    expect(message).toContain('room_members_read_after_delivered');
  });

  test('message iv sizes are bounded', async () => {
    const message = await rejectionOf(
      db`INSERT INTO messages (room_id, sender_id, idempotency_key, key_epoch, chain_index, ciphertext, iv, auth_tag)
         VALUES (${ROOM}, ${user(0)}, ${crypto.randomUUID()}, 2, 99, ${new Uint8Array([1])}, ${new Uint8Array(11)}, ${TAG})`,
    );
    expect(message).toContain('messages_iv_len');
  });
});
