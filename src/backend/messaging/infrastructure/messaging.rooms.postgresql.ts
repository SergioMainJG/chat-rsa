import { SQL } from 'bun';

import { ConflictError, ValidationError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { RoomRepository } from '../domain/messaging.repository.ts';
import { MAX_MEMBERS, MIN_MEMBERS, Room, type RoomDraft } from '../domain/messaging.room.entity.ts';
import { KeyEpoch, RoomId, RoomName } from '../domain/messaging.value-objects.ts';

type RoomRow = {
  readonly created_by: number;
  readonly id: string;
  readonly key_epoch: number;
  readonly member_ids: number[];
  readonly name: string;
};

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

export class PostgresRoomRepository extends RoomRepository {
  constructor(private readonly sql: SQL) {
    super();
  }

  override async addMember(roomId: RoomId, userId: UserId): Promise<Room> {
    await guarded(
      this.sql`INSERT INTO room_members (room_id, user_id) VALUES (${roomId}, ${userId})`,
    );
    return this.require(roomId);
  }

  /** Room and members commit together: the minimum of 2 is checked at COMMIT. */
  override async create(draft: RoomDraft): Promise<Room> {
    const id = await guarded(
      this.sql.begin(async (tx) => {
        const [row] = await tx<Array<{ id: string }>>`
          INSERT INTO rooms (name, created_by) VALUES (${draft.name.value}, ${draft.createdBy}) RETURNING id
        `;
        if (!row) {
          throw new Error('INSERT INTO rooms returned no row');
        }
        const members = draft.memberIds.map((userId) => ({ room_id: row.id, user_id: userId }));
        await tx`INSERT INTO room_members ${tx(members)}`;
        return row.id;
      }),
    );
    return this.require(RoomId.restore(id));
  }

  override async findById(roomId: RoomId): Promise<null | Room> {
    const [row] = await this.sql<RoomRow[]>`
      SELECT r.id, r.name, r.created_by, r.key_epoch,
             array_agg(m.user_id ORDER BY m.joined_at, m.user_id) AS member_ids
      FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE r.id = ${roomId}
      GROUP BY r.id
    `;
    return row ? toRoom(row) : null;
  }

  override async listForMember(userId: UserId): Promise<Room[]> {
    const rows = await this.sql<RoomRow[]>`
      SELECT r.id, r.name, r.created_by, r.key_epoch,
             array_agg(m.user_id ORDER BY m.joined_at, m.user_id) AS member_ids
      FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE r.id IN (SELECT room_id FROM room_members WHERE user_id = ${userId})
      GROUP BY r.id
      ORDER BY r.id DESC
    `;
    return rows.map((row) => toRoom(row));
  }

  override async removeMember(roomId: RoomId, userId: UserId): Promise<Room> {
    await guarded(
      this.sql`DELETE FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId}`,
    );
    return this.require(roomId);
  }

  private async require(roomId: RoomId): Promise<Room> {
    const room = await this.findById(roomId);
    if (!room) {
      throw new Error(`room ${roomId} disappeared`);
    }
    return room;
  }
}

/** Turns the capacity triggers and foreign keys of `sql/index.sql` into domain errors. */
async function guarded<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof SQL.PostgresError) {
      if (error.errno === CHECK_VIOLATION && error.constraint === 'rooms_max_members') {
        throw new ConflictError(`A room holds at most ${MAX_MEMBERS} members`);
      }
      if (error.errno === CHECK_VIOLATION && error.constraint === 'rooms_min_members') {
        throw new ConflictError(`A room needs at least ${MIN_MEMBERS} members`);
      }
      // Two concurrent adds of the same user: the second loses on the primary key.
      if (error.errno === UNIQUE_VIOLATION && error.constraint === 'room_members_pkey') {
        throw new ConflictError('User is already a member of this room');
      }
      if (error.errno === FOREIGN_KEY_VIOLATION) {
        throw new ValidationError([
          { field: 'memberIds', message: 'Every member must be an existing user' },
        ]);
      }
    }
    throw error;
  }
}

function toRoom(row: RoomRow): Room {
  return Room.restore({
    createdBy: UserId.restore(row.created_by),
    id: RoomId.restore(row.id),
    keyEpoch: KeyEpoch.restore(row.key_epoch),
    members: row.member_ids.map((id) => UserId.restore(id)),
    name: RoomName.restore(row.name),
  });
}
