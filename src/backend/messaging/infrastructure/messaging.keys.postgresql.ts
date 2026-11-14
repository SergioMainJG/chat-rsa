import { SQL } from 'bun';

import type { SenderKeyEnvelope } from '../domain/messaging.message.entity.ts';

import { ConflictError, ForbiddenError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { KeyDirectory, SenderKeyRepository } from '../domain/messaging.repository.ts';
import {
  EncryptedPayload,
  KeyEpoch,
  RoomId,
  X25519PublicKey,
} from '../domain/messaging.value-objects.ts';

type EnvelopeRow = {
  readonly auth_tag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly ephemeral_public_key: Uint8Array;
  readonly iv: Uint8Array;
  readonly key_epoch: number;
  readonly recipient_id: number;
  readonly room_id: string;
  readonly sender_id: number;
};

const FOREIGN_KEY_VIOLATION = '23503';
const NOT_A_MEMBER = 'You are not a member of this room';

export class PostgresKeyDirectory extends KeyDirectory {
  constructor(private readonly sql: SQL) {
    super();
  }

  override async find(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, X25519PublicKey>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.sql<Array<{ public_key: Uint8Array; user_id: number }>>`
      SELECT user_id, public_key FROM user_identity_keys WHERE user_id IN ${this.sql(userIds)}
      ORDER BY user_id
    `;
    return new Map(
      rows.map((row) => [
        UserId.restore(row.user_id),
        X25519PublicKey.restore(new Uint8Array(row.public_key)),
      ]),
    );
  }

  override async publish(userId: UserId, key: X25519PublicKey): Promise<void> {
    await this.sql`
      INSERT INTO user_identity_keys (user_id, public_key) VALUES (${userId}, ${key.bytes})
      ON CONFLICT (user_id) DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = now()
    `;
  }
}

export class PostgresSenderKeyRepository extends SenderKeyRepository {
  constructor(private readonly sql: SQL) {
    super();
  }

  override async forRecipient(
    roomId: RoomId,
    recipientId: UserId,
    keyEpoch: KeyEpoch,
  ): Promise<SenderKeyEnvelope[]> {
    const rows = await this.sql<EnvelopeRow[]>`
      SELECT room_id, key_epoch, sender_id, recipient_id, ephemeral_public_key, ciphertext, iv, auth_tag
      FROM sender_key_envelopes
      WHERE room_id = ${roomId} AND recipient_id = ${recipientId} AND key_epoch = ${keyEpoch}
      ORDER BY sender_id
    `;
    return rows.map((row) => toEnvelope(row));
  }

  /**
   * One transaction that re-checks the epoch under `FOR SHARE` on the room: a concurrent join or
   * leave updates that row, so it waits for this commit instead of rotating the epoch in between.
   * Every envelope of one call belongs to the same room and epoch (the use case guarantees it).
   *
   * Lock order matters: a leave locks its `room_members` row, then its trigger updates `rooms`. So
   * the member rows are locked first here too (`FOR KEY SHARE`, the lock the foreign keys take);
   * locking `rooms` first would deadlock against that leave.
   */
  override async store(envelopes: readonly SenderKeyEnvelope[]): Promise<void> {
    const [first] = envelopes;
    if (first === undefined) {
      return;
    }
    const rows = envelopes.map((envelope) => ({
      auth_tag: envelope.payload.authTag,
      ciphertext: envelope.payload.ciphertext,
      ephemeral_public_key: envelope.ephemeralPublicKey.bytes,
      iv: envelope.payload.iv,
      key_epoch: envelope.keyEpoch,
      recipient_id: envelope.recipientId,
      room_id: envelope.roomId,
      sender_id: envelope.senderId,
    }));
    try {
      await this.sql.begin(async (tx) => {
        const memberIds = [...new Set([first.senderId, ...envelopes.map((e) => e.recipientId)])];
        await tx`
          SELECT 1 FROM room_members
          WHERE room_id = ${first.roomId} AND user_id IN ${tx(memberIds)}
          ORDER BY user_id
          FOR KEY SHARE
        `;
        const [room] = await tx<Array<{ key_epoch: number }>>`
          SELECT key_epoch FROM rooms WHERE id = ${first.roomId} FOR SHARE
        `;
        if (!room) {
          throw new ForbiddenError(NOT_A_MEMBER);
        }
        if (room.key_epoch !== first.keyEpoch) {
          throw new ConflictError(`Sender key epoch is stale; rotate to epoch ${room.key_epoch}`);
        }
        await tx`
          INSERT INTO sender_key_envelopes ${tx(rows)}
          ON CONFLICT (room_id, key_epoch, sender_id, recipient_id) DO UPDATE
          SET ephemeral_public_key = EXCLUDED.ephemeral_public_key, ciphertext = EXCLUDED.ciphertext,
              iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, created_at = now()
        `;
      });
    } catch (error) {
      if (error instanceof SQL.PostgresError && error.errno === FOREIGN_KEY_VIOLATION) {
        if (error.constraint === 'sender_key_envelopes_room_id_sender_id_fkey') {
          throw new ForbiddenError(NOT_A_MEMBER);
        }
        if (error.constraint === 'sender_key_envelopes_room_id_recipient_id_fkey') {
          throw new ConflictError('Every recipient must be a current member of this room');
        }
      }
      throw error;
    }
  }
}

function toEnvelope(row: EnvelopeRow): SenderKeyEnvelope {
  return {
    ephemeralPublicKey: X25519PublicKey.restore(new Uint8Array(row.ephemeral_public_key)),
    keyEpoch: KeyEpoch.restore(row.key_epoch),
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(row.auth_tag),
      ciphertext: new Uint8Array(row.ciphertext),
      iv: new Uint8Array(row.iv),
    }),
    recipientId: UserId.restore(row.recipient_id),
    roomId: RoomId.restore(row.room_id),
    senderId: UserId.restore(row.sender_id),
  };
}
