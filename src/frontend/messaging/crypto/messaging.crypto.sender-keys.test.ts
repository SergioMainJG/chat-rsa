import { describe, expect, test } from 'bun:test';

import type { EncryptedPayloadWire } from '../../../shared/contracts/messaging.contract.ts';

import { exportPublicKey, generateIdentityKeyPair } from './messaging.crypto.primitives.ts';
import {
  createChainKey,
  decryptMessage,
  encryptMessage,
  type EnvelopeBinding,
  type MessageBinding,
  unwrapChainKey,
  wrapChainKey,
} from './messaging.crypto.sender-keys.ts';

const ROOM = '019a0000-0000-7000-8000-000000000001';
const OTHER_ROOM = '019a0000-0000-7000-8000-000000000002';

const binding: MessageBinding = {
  chainIndex: 3,
  idempotencyKey: '019a0000-0000-7000-8000-0000000000aa',
  keyEpoch: 1,
  roomId: ROOM,
  senderId: 7,
};

const envelopeBinding: EnvelopeBinding = { keyEpoch: 1, recipientId: 9, roomId: ROOM, senderId: 7 };

function tamper(base64: string): string {
  const bytes = Uint8Array.fromBase64(base64);
  bytes[0] = (bytes[0] ?? 0) === 0 ? 1 : 0;
  return bytes.toBase64();
}

describe('message encryption with a chain key', () => {
  test('the chain key is not extractable', async () => {
    const { key } = await createChainKey();

    expect(key.extractable).toBe(false);
  });

  test('round trip returns the text', async () => {
    const { key } = await createChainKey();

    const payload = await encryptMessage(key, binding, 'hola 👋');

    expect(await decryptMessage(key, binding, payload)).toBe('hola 👋');
  });

  test('tampering ciphertext, iv or authTag fails without throwing', async () => {
    const { key } = await createChainKey();
    const payload = await encryptMessage(key, binding, 'secret');

    const tampered: EncryptedPayloadWire[] = [
      { ...payload, ciphertext: tamper(payload.ciphertext) },
      { ...payload, iv: tamper(payload.iv) },
      { ...payload, authTag: tamper(payload.authTag) },
      { ...payload, iv: 'not base64!' },
      { ...payload, ciphertext: 'not base64!' },
      { ...payload, authTag: 'not base64!' },
      // Same bytes, non-canonical encoding: the wire format is strict base64 with its padding.
      { ...payload, authTag: payload.authTag.replace(/[=]+$/u, '') },
    ];
    for (const candidate of tampered) {
      // eslint-disable-next-line no-await-in-loop -- each case is checked in order
      expect(await decryptMessage(key, binding, candidate)).toBeNull();
    }
  });

  test('swapping any bound metadata fails decryption', async () => {
    const { key } = await createChainKey();
    const payload = await encryptMessage(key, binding, 'secret');

    const swapped: MessageBinding[] = [
      { ...binding, chainIndex: 4 },
      { ...binding, roomId: OTHER_ROOM },
      { ...binding, senderId: 8 },
      { ...binding, keyEpoch: 2 },
      { ...binding, idempotencyKey: '019a0000-0000-7000-8000-0000000000bb' },
    ];
    for (const candidate of swapped) {
      // eslint-disable-next-line no-await-in-loop -- each case is checked in order
      expect(await decryptMessage(key, candidate, payload)).toBeNull();
    }
  });

  test('another chain key cannot decrypt', async () => {
    const { key } = await createChainKey();
    const other = await createChainKey();

    const payload = await encryptMessage(key, binding, 'secret');

    expect(await decryptMessage(other.key, binding, payload)).toBeNull();
  });
});

describe('wrapping a chain key for a recipient', () => {
  test('the recipient unwraps a key that decrypts the sender messages', async () => {
    const recipient = await generateIdentityKeyPair();
    const chain = await createChainKey();
    const payload = await encryptMessage(chain.key, binding, 'for you');

    const wrapped = await wrapChainKey(chain.raw, await exportPublicKey(recipient.publicKey), envelopeBinding);
    const unwrapped = await unwrapChainKey(wrapped, recipient, envelopeBinding);

    expect(unwrapped).not.toBeNull();
    expect(unwrapped?.extractable).toBe(false);
    if (unwrapped !== null) {
      expect(await decryptMessage(unwrapped, binding, payload)).toBe('for you');
    }
  });

  test('a wrong recipient cannot unwrap', async () => {
    const recipient = await generateIdentityKeyPair();
    const intruder = await generateIdentityKeyPair();
    const chain = await createChainKey();

    const wrapped = await wrapChainKey(chain.raw, await exportPublicKey(recipient.publicKey), envelopeBinding);

    expect(await unwrapChainKey(wrapped, intruder, envelopeBinding)).toBeNull();
  });

  test('an envelope only unwraps under the room, epoch, sender and recipient it was made for', async () => {
    const recipient = await generateIdentityKeyPair();
    const chain = await createChainKey();
    const wrapped = await wrapChainKey(chain.raw, await exportPublicKey(recipient.publicKey), envelopeBinding);

    const swapped: EnvelopeBinding[] = [
      { ...envelopeBinding, roomId: OTHER_ROOM },
      { ...envelopeBinding, keyEpoch: 2 },
      { ...envelopeBinding, senderId: 8 },
      { ...envelopeBinding, recipientId: 10 },
    ];
    for (const candidate of swapped) {
      // eslint-disable-next-line no-await-in-loop -- each case is checked in order
      expect(await unwrapChainKey(wrapped, recipient, candidate)).toBeNull();
    }
    expect(
      await unwrapChainKey({ ...wrapped, ciphertext: tamper(wrapped.ciphertext) }, recipient, envelopeBinding),
    ).toBeNull();
  });

  test('every wrap uses a fresh ephemeral key', async () => {
    const recipient = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(recipient.publicKey);
    const chain = await createChainKey();

    const first = await wrapChainKey(chain.raw, publicKey, envelopeBinding);
    const second = await wrapChainKey(chain.raw, publicKey, envelopeBinding);

    expect(Uint8Array.fromBase64(first.ephemeralPublicKey)).toHaveLength(32);
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey);
  });
});
