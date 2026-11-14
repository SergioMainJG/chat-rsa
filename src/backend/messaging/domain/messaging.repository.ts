import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { Message, NewMessage, SenderKeyEnvelope } from './messaging.message.entity.ts';
import type { ReceiptKind, Watermarks } from './messaging.receipt.ts';
import type { Room, RoomDraft } from './messaging.room.entity.ts';
import type {
  IdempotencyKey,
  KeyEpoch,
  MessageId,
  RoomId,
  X25519PublicKey,
} from './messaging.value-objects.ts';

export type AppendOutcome = {
  /** True when the idempotency key was already stored: `message` is the original row. */
  readonly duplicate: boolean;
  readonly message: Message;
};

/** Ids are UUIDv7, so both bounds are also time bounds. */
export type HistoryQuery = {
  readonly after: MessageId | null;
  readonly before: MessageId | null;
  readonly limit: number;
};

export abstract class KeyDirectory {
  abstract find(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, X25519PublicKey>>;
  abstract publish(userId: UserId, key: X25519PublicKey): Promise<void>;
}

/** Display names of users, for members of a room the caller belongs to. */
export abstract class MemberDirectory {
  abstract names(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, string>>;
}

export abstract class MessageRepository {
  /** Stores a message once per `(senderId, idempotencyKey)`; a retry returns the original. */
  abstract append(message: NewMessage): Promise<AppendOutcome>;
  abstract exists(roomId: RoomId, messageId: MessageId): Promise<boolean>;
  abstract findByIdempotencyKey(
    senderId: UserId,
    idempotencyKey: IdempotencyKey,
  ): Promise<Message | null>;
  /** Newest first. */
  abstract page(roomId: RoomId, query: HistoryQuery): Promise<Message[]>;
}

export abstract class ReceiptRepository {
  /** Moves the member's watermark forward only, and returns the stored result. */
  abstract advance(
    roomId: RoomId,
    userId: UserId,
    kind: ReceiptKind,
    messageId: MessageId,
  ): Promise<Watermarks>;
  abstract forRoom(roomId: RoomId): Promise<ReadonlyMap<UserId, Watermarks>>;
}

export abstract class RoomRepository {
  /** Rejects with `ConflictError` when the database refuses the join (room full). */
  abstract addMember(roomId: RoomId, userId: UserId): Promise<Room>;
  abstract create(draft: RoomDraft): Promise<Room>;
  abstract findById(roomId: RoomId): Promise<null | Room>;
  abstract listForMember(userId: UserId): Promise<Room[]>;
  /** Rejects with `ConflictError` when the database refuses the leave (fewer than 2). */
  abstract removeMember(roomId: RoomId, userId: UserId): Promise<Room>;
}

export abstract class SenderKeyRepository {
  abstract forRecipient(
    roomId: RoomId,
    recipientId: UserId,
    keyEpoch: KeyEpoch,
  ): Promise<SenderKeyEnvelope[]>;
  /** Replaces envelopes with the same `(room, epoch, sender, recipient)`. */
  abstract store(envelopes: readonly SenderKeyEnvelope[]): Promise<void>;
}
