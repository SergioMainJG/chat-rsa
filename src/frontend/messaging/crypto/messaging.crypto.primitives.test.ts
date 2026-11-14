import { describe, expect, test } from 'bun:test';

import {
  AUTH_TAG_BYTES,
  type Bytes,
  deriveAesKey,
  deriveSharedSecret,
  exportPublicKey,
  generateIdentityKeyPair,
  importHkdfKey,
  importPublicKey,
  IV_BYTES,
  open,
  randomBytes,
  seal,
  utf8,
  X25519_KEY_BYTES,
} from './messaging.crypto.primitives.ts';

const AD = utf8('bound metadata');

async function aesKey(info = 'info'): Promise<CryptoKey> {
  const base = await importHkdfKey(new Uint8Array(32).fill(7));
  return deriveAesKey(base, { info: utf8(info), salt: new Uint8Array(0) });
}

function flipFirstBit(bytes: Bytes): Bytes {
  const copy = new Uint8Array(bytes);
  copy[0] = (copy[0] ?? 0) === 0 ? 1 : 0;
  return copy;
}

describe('X25519 identity', () => {
  test('the private key is not extractable', async () => {
    const identity = await generateIdentityKeyPair();

    expect(identity.privateKey.extractable).toBe(false);
    const exported = await crypto.subtle.exportKey('pkcs8', identity.privateKey).then(
      () => 'exported',
      () => 'refused',
    );
    expect(exported).toBe('refused');
  });

  test('a public key exports as 32 raw bytes and imports back to the same bytes', async () => {
    const identity = await generateIdentityKeyPair();

    const raw = await exportPublicKey(identity.publicKey);
    const again = await exportPublicKey(await importPublicKey(raw));

    expect(raw).toHaveLength(X25519_KEY_BYTES);
    expect(again).toEqual(raw);
  });

  test('both sides of an ECDH exchange derive the same secret', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();

    const fromAlice = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const fromBob = await deriveSharedSecret(bob.privateKey, alice.publicKey);

    expect(fromAlice).toEqual(fromBob);
    expect(fromAlice).toHaveLength(32);
  });
});

describe('AES-256-GCM', () => {
  test('two encryptions of the same text use different IVs', async () => {
    const key = await aesKey();

    const first = await seal(key, utf8('hello'), AD);
    const second = await seal(key, utf8('hello'), AD);

    expect(first.iv).toHaveLength(IV_BYTES);
    expect(first.authTag).toHaveLength(AUTH_TAG_BYTES);
    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  test('round trip returns the plaintext', async () => {
    const key = await aesKey();

    const box = await seal(key, utf8('hola, mundo'), AD);

    expect(await open(key, box, AD)).toEqual(utf8('hola, mundo'));
  });

  test('tampering the ciphertext, iv, authTag or additional data fails without throwing', async () => {
    const key = await aesKey();
    const box = await seal(key, utf8('secret'), AD);

    expect(await open(key, { ...box, ciphertext: flipFirstBit(box.ciphertext) }, AD)).toBeNull();
    expect(await open(key, { ...box, iv: flipFirstBit(box.iv) }, AD)).toBeNull();
    expect(await open(key, { ...box, authTag: flipFirstBit(box.authTag) }, AD)).toBeNull();
    expect(await open(key, box, utf8('other metadata'))).toBeNull();
    expect(await open(key, { ...box, iv: new Uint8Array(3) }, AD)).toBeNull();
  });
});

describe('HKDF-SHA256', () => {
  test('the same base key and info derive the same AES key; another info does not', async () => {
    const box = await seal(await aesKey('a'), utf8('x'), AD);

    expect(await open(await aesKey('a'), box, AD)).toEqual(utf8('x'));
    expect(await open(await aesKey('b'), box, AD)).toBeNull();
  });

  test('random bytes have the requested length and differ between calls', () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(randomBytes(32)).not.toEqual(randomBytes(32));
  });
});
