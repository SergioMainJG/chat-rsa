import { describe, expect, test } from 'bun:test';

import { UserId } from '../../user/domain/user.value-objects.ts';
import {
  ChainIndex,
  decodeBase64,
  EncryptedPayload,
  IdempotencyKey,
  KeyEpoch,
  MemberId,
  MessageId,
  RoomId,
} from './messaging.value-objects.ts';

// BUG-HIGH-08: anchors, strict base64, the int32 ceiling, and exact error payloads.

const V7 = '01a1d6aa-f2bb-76c2-9cf7-5666450d979a';
const V4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MAX_INT32 = 2_147_483_647;

describe('UUID anchors', () => {
  test.each([`x${V7}`, `${V7}x`, `prefix-${V7}`, `${V7}-suffix`, ` ${V7}`, `${V7}\n`])(
    'RoomId and MessageId reject %j',
    (raw) => {
      expect(RoomId.create(raw)).toEqual({ error: { field: 'roomId', message: 'roomId must be a UUIDv7' }, ok: false });
      expect(MessageId.create(raw)).toEqual({
        error: { field: 'messageId', message: 'messageId must be a UUIDv7' },
        ok: false,
      });
    },
  );

  test.each([`x${V4}`, `${V4}x`, `prefix-${V4}`, `${V4}-suffix`])('IdempotencyKey rejects %j', (raw) => {
    expect(IdempotencyKey.create(raw)).toEqual({
      error: { field: 'idempotencyKey', message: 'idempotencyKey must be a UUID' },
      ok: false,
    });
  });

  test('the bare ids are still accepted', () => {
    expect(RoomId.create(V7)).toEqual({ ok: true, value: RoomId.restore(V7) });
    expect(MessageId.create(V7)).toEqual({ ok: true, value: MessageId.restore(V7) });
    expect(IdempotencyKey.create(V4)).toEqual({ ok: true, value: IdempotencyKey.restore(V4) });
  });
});

describe('strict base64', () => {
  test.each([
    ['AQ', 'missing padding'],
    ['AR==', 'non-zero padding bits'],
    ['AQI', 'missing padding on a 2-byte chunk'],
    ['AQN=', 'non-zero padding bits on a 2-byte chunk'],
  ])('decodeBase64 rejects %j (%s)', (raw) => {
    expect(decodeBase64(raw)).toBeNull();
  });

  test('the canonical encodings decode', () => {
    expect(decodeBase64('AQ==')).toEqual(new Uint8Array([1]));
    expect(decodeBase64('AQI=')).toEqual(new Uint8Array([1, 2]));
  });

  test('a payload part in non-canonical base64 is a field error', () => {
    const iv = new Uint8Array(12).toBase64();
    const authTag = new Uint8Array(16).toBase64();
    expect(EncryptedPayload.create({ authTag, ciphertext: 'AR==', iv })).toEqual({
      error: [{ field: 'ciphertext', message: 'ciphertext must be 1 to 65536 bytes of base64' }],
      ok: false,
    });
  });
});

describe('int32 ceiling', () => {
  test('MemberId accepts 2_147_483_647 and rejects 2_147_483_648', () => {
    expect(MemberId.create(MAX_INT32, 'userId')).toEqual({ ok: true, value: UserId.restore(MAX_INT32) });
    expect(MemberId.create(MAX_INT32 + 1, 'userId')).toEqual({
      error: { field: 'userId', message: 'userId must be a positive integer' },
      ok: false,
    });
  });

  test.each([
    ['keyEpoch', (raw: unknown) => KeyEpoch.create(raw)],
    ['chainIndex', (raw: unknown) => ChainIndex.create(raw)],
  ] as const)('%s accepts 0 and 2_147_483_647 and reports the exact error otherwise', (field, create) => {
    expect(create(0)).toMatchObject({ ok: true, value: 0 });
    expect(create(MAX_INT32)).toMatchObject({ ok: true, value: MAX_INT32 });
    for (const raw of [-1, MAX_INT32 + 1, 1.5, '1', null]) {
      expect(create(raw)).toEqual({
        error: { field, message: `${field} must be an integer from 0 to ${MAX_INT32}` },
        ok: false,
      });
    }
  });
});
