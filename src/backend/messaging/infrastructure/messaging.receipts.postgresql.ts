import type { SQL } from 'bun';

import type { ReceiptKind, Watermarks } from '../domain/messaging.receipt.ts';

import { ForbiddenError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { ReceiptRepository } from '../domain/messaging.repository.ts';
import { MessageId, type RoomId } from '../domain/messaging.value-objects.ts';

type WatermarkRow = {
  readonly last_delivered_message_id: null | string;
  readonly last_read_message_id: null | string;
  readonly user_id: number;
};

export class PostgresReceiptRepository extends ReceiptRepository {
  constructor(private readonly sql: SQL) {
    super();
  }

  /**
   * One atomic UPDATE: `GREATEST` keeps both watermarks monotonic under concurrent receipts, and a
   * read also advances delivered (see `advanceWatermarks`).
   */
  override async advance(
    roomId: RoomId,
    userId: UserId,
    kind: ReceiptKind,
    messageId: MessageId,
  ): Promise<Watermarks> {
    const read = kind === 'read';
    const [row] = await this.sql<WatermarkRow[]>`
      UPDATE room_members
      SET last_delivered_message_id = GREATEST(last_delivered_message_id, ${messageId}::uuid),
          last_read_message_id = CASE WHEN ${read} THEN GREATEST(last_read_message_id, ${messageId}::uuid)
                                      ELSE last_read_message_id END
      WHERE room_id = ${roomId} AND user_id = ${userId}
      RETURNING user_id, last_delivered_message_id, last_read_message_id
    `;
    if (!row) {
      // The member left after the use case checked membership: same answer as any non-member.
      throw new ForbiddenError('You are not a member of this room');
    }
    return toWatermarks(row);
  }

  override async forRoom(roomId: RoomId): Promise<ReadonlyMap<UserId, Watermarks>> {
    const rows = await this.sql<WatermarkRow[]>`
      SELECT user_id, last_delivered_message_id, last_read_message_id
      FROM room_members WHERE room_id = ${roomId}
    `;
    return new Map(rows.map((row) => [UserId.restore(row.user_id), toWatermarks(row)]));
  }
}

function toWatermarks(row: WatermarkRow): Watermarks {
  return {
    delivered:
      row.last_delivered_message_id === null
        ? null
        : MessageId.restore(row.last_delivered_message_id),
    read: row.last_read_message_id === null ? null : MessageId.restore(row.last_read_message_id),
  };
}
