import type {
  IdentityKeyView,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type {
  KeyDirectory,
  RoomRepository,
  SenderKeyRepository,
} from '../domain/messaging.repository.ts';

import {
  type AppError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../shared/domain/app.error.ts';
import { err, ok, okVoid, type Result } from '../../shared/domain/result.ts';
import { envelopeView, type SenderKeyEnvelope } from '../domain/messaging.message.entity.ts';
import { MAX_MEMBERS, type Room } from '../domain/messaging.room.entity.ts';
import {
  EncryptedPayload,
  KeyEpoch,
  MAX_ENVELOPE_BYTES,
  MemberId,
  X25519PublicKey,
} from '../domain/messaging.value-objects.ts';
import { Fields, type Input, isAbsent, roomOfMember } from './messaging.access.ts';

export type StoredSenderKeys = {
  readonly keyEpoch: number;
  readonly stored: number;
};

/** A recipient reads the chain keys wrapped for them, for the current epoch unless one is given. */
export class FetchSenderKeysUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly senderKeys: SenderKeyRepository,
  ) {}

  async execute(
    actor: UserId,
    rawRoomId: unknown,
    query: Input,
  ): Promise<Result<SenderKeyEnvelopeView[], AppError>> {
    const epoch = isAbsent(query.keyEpoch) ? null : KeyEpoch.create(Number(query.keyEpoch));
    if (epoch !== null && !epoch.ok) {
      return err(new ValidationError([epoch.error]));
    }
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const keyEpoch = epoch === null ? room.value.keyEpoch : epoch.value;
    const envelopes = await this.senderKeys.forRecipient(room.value.id, actor, keyEpoch);
    return ok(envelopes.map((envelope) => envelopeView(envelope)));
  }
}

/** Identity public keys of the members of a room the actor belongs to. */
export class ListRoomKeysUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly keys: KeyDirectory,
  ) {}

  async execute(actor: UserId, rawRoomId: unknown): Promise<Result<IdentityKeyView[], AppError>> {
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const keys = await this.keys.find(room.value.memberIds);
    return ok([...keys].map(([userId, key]) => ({ publicKey: key.toBase64(), userId })));
  }
}

/** Publishes the caller's X25519 identity public key; its private key never leaves the browser. */
export class PublishIdentityKeyUseCase {
  constructor(private readonly keys: KeyDirectory) {}

  async execute(actor: UserId, input: Input): Promise<Result<IdentityKeyView, AppError>> {
    const key = X25519PublicKey.create(input.publicKey, 'publicKey');
    if (!key.ok) {
      return err(new ValidationError([key.error]));
    }
    await this.keys.publish(actor, key.value);
    return ok({ publicKey: key.value.toBase64(), userId: actor });
  }
}

/**
 * Stores the sender's chain key for the current epoch, wrapped once per recipient. Recipients must
 * be current members, so a removed member never receives a new key.
 */
export class StoreSenderKeysUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly senderKeys: SenderKeyRepository,
  ) {}

  async execute(actor: UserId, input: Input): Promise<Result<StoredSenderKeys, AppError>> {
    const fields = new Fields();
    const keyEpoch = fields.take(KeyEpoch.create(input.keyEpoch));
    const raw = input.envelopes;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEMBERS) {
      fields.push({
        field: 'envelopes',
        message: `envelopes must hold 1 to ${MAX_MEMBERS} entries`,
      });
    }
    if (keyEpoch === undefined || !Array.isArray(raw) || fields.hasErrors()) {
      return err(fields.error());
    }
    const room = await roomOfMember(this.rooms, input.roomId, actor);
    if (!room.ok) {
      return room;
    }
    const current = room.value.assertCurrentEpoch(keyEpoch);
    if (!current.ok) {
      return current;
    }
    const envelopes = raw.map((entry: unknown, index) =>
      envelopeOf(entry, index, { actor, fields, keyEpoch, room: room.value }),
    );
    const distinct = distinctRecipients(envelopes, fields);
    if (!distinct.ok || fields.hasErrors()) {
      return err(fields.error());
    }
    const valid = envelopes.filter((envelope) => envelope !== undefined);
    try {
      await this.senderKeys.store(valid);
    } catch (error) {
      // A join or leave committed after the checks above: the client re-reads the room and retries.
      if (error instanceof ConflictError || error instanceof ForbiddenError) {
        return err(error);
      }
      throw error;
    }
    return ok({ keyEpoch, stored: valid.length });
  }
}

function distinctRecipients(
  envelopes: ReadonlyArray<SenderKeyEnvelope | undefined>,
  fields: Fields,
): Result<void, ValidationError> {
  const seen = new Set<UserId>();
  for (const [index, envelope] of envelopes.entries()) {
    if (envelope && seen.has(envelope.recipientId)) {
      fields.push({ field: `envelopes[${index}].recipientId`, message: 'Recipient appears twice' });
      return err(fields.error());
    }
    if (envelope) {
      seen.add(envelope.recipientId);
    }
  }
  return okVoid();
}

function envelopeOf(
  entry: unknown,
  index: number,
  context: {
    readonly actor: UserId;
    readonly fields: Fields;
    readonly keyEpoch: KeyEpoch;
    readonly room: Room;
  },
): SenderKeyEnvelope | undefined {
  const { actor, fields, keyEpoch, room } = context;
  const at = `envelopes[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    fields.push({ field: at, message: `${at} must be an object` });
    return undefined;
  }
  const record: Input = Object.fromEntries(Object.entries(entry));
  const recipientId = fields.take(MemberId.create(record.recipientId, `${at}.recipientId`));
  const ephemeralPublicKey = fields.take(
    X25519PublicKey.create(record.ephemeralPublicKey, `${at}.ephemeralPublicKey`),
  );
  const payload = fields.take(prefixed(EncryptedPayload.create(record, MAX_ENVELOPE_BYTES), at));
  if (recipientId !== undefined && !room.isMember(recipientId)) {
    fields.push({ field: `${at}.recipientId`, message: 'Recipient is not a member of this room' });
    return undefined;
  }
  if (recipientId === undefined || ephemeralPublicKey === undefined || payload === undefined) {
    return undefined;
  }
  return { ephemeralPublicKey, keyEpoch, payload, recipientId, roomId: room.id, senderId: actor };
}

function prefixed<T>(
  result: Result<T, Array<{ field: string; message: string }>>,
  at: string,
): Result<T, Array<{ field: string; message: string }>> {
  return result.ok
    ? result
    : err(
        result.error.map(({ field, message }) => ({
          field: `${at}.${field}`,
          message: `${at}.${message}`,
        })),
      );
}
