import type { UserId } from '../../user/domain/user.value-objects.ts';

import { ConflictError, ForbiddenError } from '../../shared/domain/app.error.ts';
import {
  Message,
  type NewMessage,
  type SenderKeyEnvelope,
} from '../domain/messaging.message.entity.ts';
import {
  advanceWatermarks,
  type ReceiptKind,
  type Watermarks,
} from '../domain/messaging.receipt.ts';
import {
  type AppendOutcome,
  type HistoryQuery,
  KeyDirectory,
  MemberDirectory,
  MessageRepository,
  ReceiptRepository,
  RoomRepository,
  SenderKeyRepository,
} from '../domain/messaging.repository.ts';
import { MAX_MEMBERS, MIN_MEMBERS, Room, type RoomDraft } from '../domain/messaging.room.entity.ts';
import {
  type IdempotencyKey,
  KeyEpoch,
  type MessageId,
  RoomId,
  uuidV7Bound,
  type X25519PublicKey,
} from '../domain/messaging.value-objects.ts';

/** Deterministic UUIDv7 ids: one per millisecond from a fixed start, so order is creation order. */
let clock = Date.UTC(2026, 10, 12);

export class InMemoryKeyDirectory extends KeyDirectory {
  readonly keys = new Map<UserId, X25519PublicKey>();

  override async find(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, X25519PublicKey>> {
    return new Map(
      userIds.flatMap((id) => {
        const key = this.keys.get(id);
        return key ? [[id, key] as const] : [];
      }),
    );
  }

  override async publish(userId: UserId, key: X25519PublicKey): Promise<void> {
    this.keys.set(userId, key);
  }
}

export class InMemoryMemberDirectory extends MemberDirectory {
  constructor(readonly users = new Map<UserId, string>()) {
    super();
  }

  override async names(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, string>> {
    return new Map(
      userIds.flatMap((id) => {
        const name = this.users.get(id);
        return name === undefined ? [] : [[id, name] as const];
      }),
    );
  }
}

export class InMemoryMessageRepository extends MessageRepository {
  readonly messages: Message[] = [];

  override async append(draft: NewMessage): Promise<AppendOutcome> {
    const existing = await this.findByIdempotencyKey(draft.senderId, draft.idempotencyKey);
    if (existing) {
      return { duplicate: true, message: existing };
    }
    const ms = nextMs();
    const message = new Message(uuidV7Bound(ms, 'min'), new Date(ms), draft);
    this.messages.push(message);
    return { duplicate: false, message };
  }

  override async exists(roomId: RoomId, messageId: MessageId): Promise<boolean> {
    return this.messages.some((message) => message.roomId === roomId && message.id === messageId);
  }

  override async findByIdempotencyKey(
    senderId: UserId,
    idempotencyKey: IdempotencyKey,
  ): Promise<Message | null> {
    return (
      this.messages.find(
        (message) =>
          message.senderId === senderId && message.draft.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  override async page(roomId: RoomId, { after, before, limit }: HistoryQuery): Promise<Message[]> {
    return this.messages
      .filter(
        (message) =>
          message.roomId === roomId &&
          (before === null || message.id < before) &&
          (after === null || message.id > after),
      )
      .toSorted((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}

export class InMemoryReceiptRepository extends ReceiptRepository {
  readonly marks = new Map<string, Watermarks>();

  constructor(private readonly rooms: InMemoryRoomRepository) {
    super();
  }

  override async advance(
    roomId: RoomId,
    userId: UserId,
    kind: ReceiptKind,
    messageId: MessageId,
  ): Promise<Watermarks> {
    // Mirrors the UPDATE on room_members, which matches no row for a non-member.
    const room = await this.rooms.findById(roomId);
    if (!room?.isMember(userId)) {
      throw new ForbiddenError('You are not a member of this room');
    }
    const key = `${roomId}:${userId}`;
    const next = advanceWatermarks(
      this.marks.get(key) ?? { delivered: null, read: null },
      kind,
      messageId,
    );
    this.marks.set(key, next);
    return next;
  }

  override async forRoom(roomId: RoomId): Promise<ReadonlyMap<UserId, Watermarks>> {
    const room = await this.rooms.findById(roomId);
    return new Map(
      (room?.memberIds ?? []).map((id) => [
        id,
        this.marks.get(`${roomId}:${id}`) ?? { delivered: null, read: null },
      ]),
    );
  }
}

function nextMs(): number {
  clock += 1;
  return clock;
}

/** Mirrors the database: a member counter capped at 100, a floor of 2, and an epoch bump per change. */
export class InMemoryRoomRepository extends RoomRepository {
  readonly rooms = new Map<RoomId, Room>();
  /** User ids that exist; the database rejects unknown members through a foreign key. */
  readonly users = new Set<UserId>();

  override async addMember(roomId: RoomId, userId: UserId): Promise<Room> {
    const room = this.require(roomId);
    if (room.memberCount >= MAX_MEMBERS) {
      throw new ConflictError(`A room holds at most ${MAX_MEMBERS} members`);
    }
    return this.save(room, [...room.memberIds, userId]);
  }

  override async create(draft: RoomDraft): Promise<Room> {
    const ms = nextMs();
    const room = Room.restore({
      createdBy: draft.createdBy,
      id: RoomId.restore(uuidV7Bound(ms, 'min')),
      keyEpoch: KeyEpoch.restore(draft.memberIds.length),
      members: draft.memberIds,
      name: draft.name,
    });
    this.rooms.set(room.id, room);
    return room;
  }

  override async findById(roomId: RoomId): Promise<null | Room> {
    return this.rooms.get(roomId) ?? null;
  }

  override async listForMember(userId: UserId): Promise<Room[]> {
    return [...this.rooms.values()].filter((room) => room.isMember(userId));
  }

  override async removeMember(roomId: RoomId, userId: UserId): Promise<Room> {
    const room = this.require(roomId);
    if (room.memberCount <= MIN_MEMBERS) {
      throw new ConflictError(`A room needs at least ${MIN_MEMBERS} members`);
    }
    return this.save(
      room,
      room.memberIds.filter((id) => id !== userId),
    );
  }

  private require(roomId: RoomId): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`room ${roomId} does not exist`);
    }
    return room;
  }

  private save(room: Room, members: readonly UserId[]): Room {
    const next = Room.restore({
      createdBy: room.createdBy,
      id: room.id,
      keyEpoch: KeyEpoch.restore(room.keyEpoch + 1),
      members,
      name: room.name,
    });
    this.rooms.set(room.id, next);
    return next;
  }
}

export class InMemorySenderKeyRepository extends SenderKeyRepository {
  readonly envelopes: SenderKeyEnvelope[] = [];

  override async forRecipient(
    roomId: RoomId,
    recipientId: UserId,
    keyEpoch: KeyEpoch,
  ): Promise<SenderKeyEnvelope[]> {
    return this.envelopes.filter(
      (envelope) =>
        envelope.roomId === roomId &&
        envelope.recipientId === recipientId &&
        envelope.keyEpoch === keyEpoch,
    );
  }

  override async store(envelopes: readonly SenderKeyEnvelope[]): Promise<void> {
    for (const envelope of envelopes) {
      const index = this.envelopes.findIndex(
        (stored) =>
          stored.roomId === envelope.roomId &&
          stored.keyEpoch === envelope.keyEpoch &&
          stored.senderId === envelope.senderId &&
          stored.recipientId === envelope.recipientId,
      );
      if (index === -1) {
        this.envelopes.push(envelope);
      } else {
        this.envelopes[index] = envelope;
      }
    }
  }
}

/** Base64 of `length` zero bytes, for payload fields in tests. */
export function zeros(length: number): string {
  return new Uint8Array(length).toBase64();
}
