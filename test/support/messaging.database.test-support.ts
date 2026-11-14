import type { ReservedSQL } from 'bun';

import type { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import type { RoomId } from '../../src/backend/messaging/domain/messaging.value-objects.ts';

import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { UserId } from '../../src/backend/user/domain/user.value-objects.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

export type IsolatedDatabase = {
  readonly close: () => Promise<void>;
  readonly db: ReservedSQL;
  /** Another connection on the same schema, for tests that race two transactions. */
  readonly reserve: () => Promise<ReservedSQL>;
  readonly user: (index: number) => UserId;
};

/** A brand-new schema with `userCount` users, so a test never sees the running server's rows. */
export async function isolatedDatabase(userCount: number): Promise<IsolatedDatabase> {
  const sql = createPostgresClient({ max: 2, url: loadConfig().databaseUrl });
  const schema = `schema_${crypto.randomUUID().replaceAll('-', '')}`;
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  const db = await sql.reserve();
  await db.unsafe(`SET search_path TO "${schema}"`);
  await applyUserSchema(db);
  const rows = await db<Array<{ id: number }>>`
    INSERT INTO users (name, password) SELECT 'u' || g, 'x' FROM generate_series(1, ${userCount}) g
    RETURNING id
  `;
  const users = rows.map((row) => UserId.restore(row.id));
  const extra: ReservedSQL[] = [];
  return {
    close: async () => {
      for (const connection of extra) {
        // eslint-disable-next-line no-await-in-loop
        await connection.release();
      }
      await db.release();
      await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.close();
    },
    db,
    reserve: async () => {
      const connection = await sql.reserve();
      await connection.unsafe(`SET search_path TO "${schema}"`);
      extra.push(connection);
      return connection;
    },
    user: (index) => {
      const id = users[index];
      if (id === undefined) {
        throw new Error(`no user ${index}`);
      }
      return id;
    },
  };
}

/**
 * Serves a frozen copy of a room, as a use case sees it when a concurrent join or leave commits
 * between its membership check and its write. Freeze after the change: `addMember` and
 * `removeMember` re-read the room through `findById`.
 */
export class StaleRoomRepository extends PostgresRoomRepository {
  private readonly frozen = new Map<RoomId, Room>();

  override async findById(roomId: RoomId): Promise<null | Room> {
    return this.frozen.get(roomId) ?? super.findById(roomId);
  }

  freeze(room: Room): void {
    this.frozen.set(room.id, room);
  }
}
