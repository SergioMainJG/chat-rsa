import { SQL } from 'bun';

import { ConflictError, ForbiddenError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { Message, type NewMessage } from '../domain/messaging.message.entity.ts';
import {
  type AppendOutcome,
  type HistoryQuery,
  MessageRepository,
} from '../domain/messaging.repository.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
  MessageId,
  RoomId,
} from '../domain/messaging.value-objects.ts';

type MessageRow = {
  readonly auth_tag: Uint8Array;
  readonly chain_index: number;
  readonly ciphertext: Uint8Array;
  readonly created_at: Date;
  readonly id: string;
  readonly idempotency_key: string;
  readonly iv: Uint8Array;
  readonly key_epoch: number;
  readonly room_id: string;
  readonly sender_id: number;
};

/** SQLSTATE raised by the `messages_assert_sender_is_member` trigger. */
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
/** SQLSTATE the same trigger raises, as `messages_current_key_epoch`, for a rotated key epoch. */
const CHECK_VIOLATION = '23514';

export class PostgresMessageRepository extends MessageRepository {
  constructor(private readonly sql: SQL) {
    super();
  }

  /** `id` and `created_at` are never sent: PostgreSQL generates the UUIDv7 and derives the time. */
  override async append(message: NewMessage): Promise<AppendOutcome> {
    const { payload } = message;
    try {
      const [row] = await this.sql<MessageRow[]>`
        INSERT INTO messages (room_id, sender_id, idempotency_key, key_epoch, chain_index, ciphertext, iv, auth_tag)
        VALUES (${message.roomId}, ${message.senderId}, ${message.idempotencyKey}, ${message.keyEpoch},
                ${message.chainIndex}, ${payload.ciphertext}, ${payload.iv}, ${payload.authTag})
        ON CONFLICT (sender_id, idempotency_key) DO NOTHING
        RETURNING *
      `;
      if (row) {
        return { duplicate: false, message: toMessage(row) };
      }
    } catch (error) {
      if (error instanceof SQL.PostgresError && error.errno === INSUFFICIENT_PRIVILEGE) {
        throw new ForbiddenError('You are not a member of this room');
      }
      // Two tabs without a shared counter can pick the same chain index; the client re-encrypts
      // on `conflict` with the next index.
      if (
        error instanceof SQL.PostgresError &&
        error.errno === UNIQUE_VIOLATION &&
        error.constraint === 'messages_chain_uq'
      ) {
        throw new ConflictError('chainIndex was already used in this key epoch; encrypt again');
      }
      // The trigger re-checks the epoch under a lock on the room, closing the in-memory check race.
      if (
        error instanceof SQL.PostgresError &&
        error.errno === CHECK_VIOLATION &&
        error.constraint === 'messages_current_key_epoch'
      ) {
        throw new ConflictError(`Sender key epoch is stale; rotate to epoch ${error.detail}`);
      }
      throw error;
    }
    const original = await this.findByIdempotencyKey(message.senderId, message.idempotencyKey);
    if (!original) {
      throw new Error('idempotency conflict without a stored row');
    }
    return { duplicate: true, message: original };
  }

  override async exists(roomId: RoomId, messageId: MessageId): Promise<boolean> {
    const rows = await this.sql<Array<{ found: number }>>`
      SELECT 1 AS found FROM messages WHERE room_id = ${roomId} AND id = ${messageId}
    `;
    return rows.length > 0;
  }

  override async findByIdempotencyKey(
    senderId: UserId,
    idempotencyKey: IdempotencyKey,
  ): Promise<Message | null> {
    const [row] = await this.sql<MessageRow[]>`
      SELECT * FROM messages WHERE sender_id = ${senderId} AND idempotency_key = ${idempotencyKey}
    `;
    return row ? toMessage(row) : null;
  }

  /** Served by `messages_room_id_desc_idx (room_id, id DESC)`. */
  override async page(roomId: RoomId, { after, before, limit }: HistoryQuery): Promise<Message[]> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM messages
      WHERE room_id = ${roomId}
        AND (${before}::uuid IS NULL OR id < ${before}::uuid)
        AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => toMessage(row));
  }
}

function toMessage(row: MessageRow): Message {
  return new Message(MessageId.restore(row.id), row.created_at, {
    chainIndex: ChainIndex.restore(row.chain_index),
    idempotencyKey: IdempotencyKey.restore(row.idempotency_key),
    keyEpoch: KeyEpoch.restore(row.key_epoch),
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(row.auth_tag),
      ciphertext: new Uint8Array(row.ciphertext),
      iv: new Uint8Array(row.iv),
    }),
    roomId: RoomId.restore(row.room_id),
    senderId: UserId.restore(row.sender_id),
  });
}
