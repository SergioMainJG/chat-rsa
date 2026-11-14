import type { FieldError } from '../../../shared/contracts/error.contract.ts';
import type { EncryptedPayloadWire } from '../../../shared/contracts/messaging.contract.ts';

import { brand, type Brand } from '../../shared/domain/brand.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';

export type ChainIndex = Brand<number, 'ChainIndex'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type KeyEpoch = Brand<number, 'KeyEpoch'>;
export type MessageId = Brand<string, 'MessageId'>;
export type RoomId = Brand<string, 'RoomId'>;

/** Largest accepted ciphertext; matches `messages_ciphertext_len` in `sql/index.sql`. */
export const MAX_CIPHERTEXT_BYTES = 65_536;
/** Largest wrapped sender key; matches `sender_key_envelopes_ciphertext_len`. */
export const MAX_ENVELOPE_BYTES = 256;
export const IV_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const X25519_KEY_BYTES = 32;
export const MAX_ROOM_NAME_LENGTH = 100;

const MAX_INT32 = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Strict base64 to bytes, or null when the text is not base64. */
export function decodeBase64(raw: unknown): null | Uint8Array {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    return Uint8Array.fromBase64(raw, { lastChunkHandling: 'strict' });
  } catch {
    return null;
  }
}

function bytesOf(
  raw: unknown,
  field: string,
  { max, min }: { readonly max: number; readonly min: number },
): Result<Uint8Array, FieldError> {
  const bytes = decodeBase64(raw);
  if (bytes === null || bytes.length < min || bytes.length > max) {
    const size = min === max ? `${min}` : `${min} to ${max}`;
    return err({ field, message: `${field} must be ${size} bytes of base64` });
  }
  return ok(bytes);
}

function int32(raw: unknown, field: string): Result<number, FieldError> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_INT32) {
    return err({ field, message: `${field} must be an integer from 0 to ${MAX_INT32}` });
  }
  return ok(raw);
}

function uuidV7(raw: unknown, field: string): Result<string, FieldError> {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  return UUID_V7_PATTERN.test(value)
    ? ok(value)
    : err({ field, message: `${field} must be a UUIDv7` });
}

/** Server-generated, time-ordered room id. */
export const RoomId = {
  create(raw: unknown, field = 'roomId'): Result<RoomId, FieldError> {
    const result = uuidV7(raw, field);
    return result.ok ? ok(brand<string, 'RoomId'>(result.value)) : result;
  },
  restore(value: string): RoomId {
    return brand<string, 'RoomId'>(value);
  },
};

/**
 * Server-generated UUIDv7: its order is the canonical chronology, so lower-case ids compare like
 * timestamps.
 */
export const MessageId = {
  create(raw: unknown, field = 'messageId'): Result<MessageId, FieldError> {
    const result = uuidV7(raw, field);
    return result.ok ? ok(brand<string, 'MessageId'>(result.value)) : result;
  },
  restore(value: string): MessageId {
    return brand<string, 'MessageId'>(value);
  },
};

/** Client-chosen per message, so a retried send never stores a second row. */
export const IdempotencyKey = {
  create(raw: unknown): Result<IdempotencyKey, FieldError> {
    const value = typeof raw === 'string' ? raw.toLowerCase() : '';
    return UUID_PATTERN.test(value)
      ? ok(brand<string, 'IdempotencyKey'>(value))
      : err({ field: 'idempotencyKey', message: 'idempotencyKey must be a UUID' });
  },
  restore(value: string): IdempotencyKey {
    return brand<string, 'IdempotencyKey'>(value);
  },
};

/** Sender-key generation of a room; bumped by the database on every join and leave. */
export const KeyEpoch = {
  create(raw: unknown): Result<KeyEpoch, FieldError> {
    const result = int32(raw, 'keyEpoch');
    return result.ok ? ok(brand<number, 'KeyEpoch'>(result.value)) : result;
  },
  restore(value: number): KeyEpoch {
    return brand<number, 'KeyEpoch'>(value);
  },
};

/** Position of a message key in its sender's chain; never reused within one epoch. */
export const ChainIndex = {
  create(raw: unknown): Result<ChainIndex, FieldError> {
    const result = int32(raw, 'chainIndex');
    return result.ok ? ok(brand<number, 'ChainIndex'>(result.value)) : result;
  },
  restore(value: number): ChainIndex {
    return brand<number, 'ChainIndex'>(value);
  },
};

export class RoomName {
  private constructor(readonly value: Brand<string, 'RoomName'>) {}

  static create(raw: unknown): Result<RoomName, FieldError> {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0 || value.length > MAX_ROOM_NAME_LENGTH) {
      return err({
        field: 'name',
        message: `Room name must be 1 to ${MAX_ROOM_NAME_LENGTH} characters`,
      });
    }
    return ok(new RoomName(brand<string, 'RoomName'>(value)));
  }

  static restore(value: string): RoomName {
    return new RoomName(brand<string, 'RoomName'>(value));
  }
}

/** Raw X25519 public key. The server never sees a private key. */
export class X25519PublicKey {
  private constructor(readonly bytes: Uint8Array) {}

  static create(raw: unknown, field: string): Result<X25519PublicKey, FieldError> {
    const bytes = bytesOf(raw, field, { max: X25519_KEY_BYTES, min: X25519_KEY_BYTES });
    return bytes.ok ? ok(new X25519PublicKey(bytes.value)) : bytes;
  }

  static restore(bytes: Uint8Array): X25519PublicKey {
    return new X25519PublicKey(bytes);
  }

  toBase64(): string {
    return this.bytes.toBase64();
  }
}

/** AES-256-GCM output the server stores without being able to read it. */
export class EncryptedPayload {
  private constructor(
    readonly ciphertext: Uint8Array,
    readonly iv: Uint8Array,
    readonly authTag: Uint8Array,
  ) {}

  /** Validates every part and reports all malformed ones at once. */
  static create(
    raw: { readonly authTag?: unknown; readonly ciphertext?: unknown; readonly iv?: unknown },
    maxCiphertextBytes = MAX_CIPHERTEXT_BYTES,
  ): Result<EncryptedPayload, FieldError[]> {
    const ciphertext = bytesOf(raw.ciphertext, 'ciphertext', { max: maxCiphertextBytes, min: 1 });
    const iv = bytesOf(raw.iv, 'iv', { max: IV_BYTES, min: IV_BYTES });
    const authTag = bytesOf(raw.authTag, 'authTag', { max: AUTH_TAG_BYTES, min: AUTH_TAG_BYTES });
    if (ciphertext.ok && iv.ok && authTag.ok) {
      return ok(new EncryptedPayload(ciphertext.value, iv.value, authTag.value));
    }
    return err([ciphertext, iv, authTag].flatMap((part) => (part.ok ? [] : [part.error])));
  }

  static restore(parts: {
    readonly authTag: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly iv: Uint8Array;
  }): EncryptedPayload {
    return new EncryptedPayload(parts.ciphertext, parts.iv, parts.authTag);
  }

  toWire(): EncryptedPayloadWire {
    return {
      authTag: this.authTag.toBase64(),
      ciphertext: this.ciphertext.toBase64(),
      iv: this.iv.toBase64(),
    };
  }
}

/** A user id sent by a client (room members, envelope recipients). */
export const MemberId = {
  create(raw: unknown, field: string): Result<UserId, FieldError> {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_INT32) {
      return err({ field, message: `${field} must be a positive integer` });
    }
    return ok(UserId.restore(raw));
  },
};

/**
 * The smallest or largest UUIDv7 of a millisecond. Ids are time-ordered, so these turn a time range
 * into an id range that the `(room_id, id DESC)` index serves.
 */
export function uuidV7Bound(ms: number, edge: 'max' | 'min'): MessageId {
  const hex = Math.max(0, Math.trunc(ms)).toString(16).padStart(12, '0');
  const tail = edge === 'min' ? '7000-8000-000000000000' : '7fff-bfff-ffffffffffff';
  return MessageId.restore(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${tail}`);
}
