import { describe, expect, test } from 'bun:test';

import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
  MAX_CIPHERTEXT_BYTES,
  MemberId,
  MessageId,
  RoomId,
  RoomName,
  uuidV7Bound,
  X25519PublicKey,
} from './messaging.value-objects.ts';

const V7 = '01a1d2f6-0c3b-7f64-aba0-86283af1bcda';
const V4 = '11111111-1111-4111-8111-111111111111';

function base64(length: number): string {
  return new Uint8Array(length).toBase64();
}

describe('RoomId and MessageId', () => {
  test('accept a UUIDv7 and normalize it to lower case', () => {
    const result = RoomId.create(V7.toUpperCase(), 'roomId');
    expect(result).toEqual({ ok: true, value: RoomId.restore(V7) });
    expect(MessageId.create(V7, 'before').ok).toBe(true);
  });

  test.each([V4, 'not-a-uuid', '', 42, null])('reject %p as a UUIDv7', (raw) => {
    expect(RoomId.create(raw, 'roomId')).toEqual({
      error: { field: 'roomId', message: 'roomId must be a UUIDv7' },
      ok: false,
    });
  });
});

describe('IdempotencyKey', () => {
  test('accepts any RFC 9562 UUID', () => {
    expect(IdempotencyKey.create(V4)).toEqual({ ok: true, value: IdempotencyKey.restore(V4) });
  });

  test('rejects anything else', () => {
    expect(IdempotencyKey.create('retry-1')).toEqual({
      error: { field: 'idempotencyKey', message: 'idempotencyKey must be a UUID' },
      ok: false,
    });
  });
});

describe('RoomName', () => {
  test('keeps a trimmed name of 1 to 100 characters', () => {
    const result = RoomName.create('  Team  ');
    expect(result.ok ? result.value.value.toString() : '').toBe('Team');
    expect(RoomName.create('x'.repeat(100)).ok).toBe(true);
  });

  test.each<unknown>(['   ', '', 7, 'x'.repeat(101)])('rejects %p', (raw) => {
    expect(RoomName.create(raw).ok).toBe(false);
  });
});

describe('KeyEpoch and ChainIndex', () => {
  test('accept non-negative 32-bit integers', () => {
    expect(KeyEpoch.create(0).ok).toBe(true);
    expect(ChainIndex.create(2_147_483_647).ok).toBe(true);
  });

  test.each([-1, 1.5, '3', 2_147_483_648, Number.NaN])('reject %p', (raw) => {
    expect(KeyEpoch.create(raw).ok).toBe(false);
    expect(ChainIndex.create(raw).ok).toBe(false);
  });
});

describe('EncryptedPayload', () => {
  test('decodes base64 ciphertext, a 12-byte iv and a 16-byte auth tag', () => {
    const result = EncryptedPayload.create({ authTag: base64(16), ciphertext: 'AQID', iv: base64(12) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.ciphertext]).toEqual([1, 2, 3]);
      expect(result.value.iv).toHaveLength(12);
      expect(result.value.authTag).toHaveLength(16);
    }
  });

  test('reports every malformed part', () => {
    expect(EncryptedPayload.create({ authTag: base64(15), ciphertext: '', iv: '@@' })).toEqual({
      error: [
        { field: 'ciphertext', message: `ciphertext must be 1 to ${MAX_CIPHERTEXT_BYTES} bytes of base64` },
        { field: 'iv', message: 'iv must be 12 bytes of base64' },
        { field: 'authTag', message: 'authTag must be 16 bytes of base64' },
      ],
      ok: false,
    });
  });

  test('rejects ciphertext over the size limit', () => {
    const result = EncryptedPayload.create({
      authTag: base64(16),
      ciphertext: base64(MAX_CIPHERTEXT_BYTES + 1),
      iv: base64(12),
    });
    expect(result.ok).toBe(false);
  });

  test('round-trips to the wire format', () => {
    const wire = { authTag: base64(16), ciphertext: 'AQID', iv: base64(12) };
    const result = EncryptedPayload.create(wire);
    expect(result.ok && result.value.toWire()).toEqual(wire);
  });
});

describe('X25519PublicKey', () => {
  test('accepts exactly 32 bytes of base64', () => {
    expect(X25519PublicKey.create(base64(32), 'publicKey').ok).toBe(true);
  });

  test('rejects any other length', () => {
    expect(X25519PublicKey.create(base64(31), 'publicKey')).toEqual({
      error: { field: 'publicKey', message: 'publicKey must be 32 bytes of base64' },
      ok: false,
    });
  });
});

describe('uuidV7Bound', () => {
  test('brackets every UUIDv7 generated in that millisecond', () => {
    const ms = Date.UTC(2026, 10, 12, 10);
    const min = uuidV7Bound(ms, 'min');
    const max = uuidV7Bound(ms, 'max');
    expect(MessageId.create(min).ok).toBe(true);
    expect(MessageId.create(max).ok).toBe(true);
    expect(min < max).toBe(true);
    expect(uuidV7Bound(ms - 1, 'max') < min).toBe(true);
    expect(min.slice(0, 13)).toBe(
      `${ms.toString(16).padStart(12, '0').slice(0, 8)}-${ms.toString(16).padStart(12, '0').slice(8)}`,
    );
  });
});

describe('MemberId', () => {
  test('accepts a positive integer user id', () => {
    expect(MemberId.create(7, 'userId').ok).toBe(true);
  });

  test.each<unknown>([0, -1, 1.5, '7', null])('rejects %p', (raw) => {
    expect(MemberId.create(raw, 'userId')).toEqual({
      error: { field: 'userId', message: 'userId must be a positive integer' },
      ok: false,
    });
  });
});
