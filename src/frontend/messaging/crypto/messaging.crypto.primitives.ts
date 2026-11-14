/**
 * Thin wrappers over Web Crypto (`crypto.subtle`): X25519 key agreement, HKDF-SHA256 derivation and
 * AES-256-GCM authenticated encryption. No third-party crypto.
 */

/** Bytes backed by a plain `ArrayBuffer`, which is what Web Crypto accepts as `BufferSource`. */
export type Bytes = Uint8Array<ArrayBuffer>;

export type IdentityKeyPair = {
  /** Never extractable: it cannot leave this browser's key store. */
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
};

/** An AES-GCM output split as the server stores it. */
export type SealedBox = {
  readonly authTag: Bytes;
  readonly ciphertext: Bytes;
  readonly iv: Bytes;
};

export const AUTH_TAG_BYTES = 16;
export const IV_BYTES = 12;
export const X25519_KEY_BYTES = 32;

const AES_GCM = 'AES-GCM';
const AUTH_TAG_BITS = AUTH_TAG_BYTES * 8;
const X25519 = 'X25519';

/** Joins byte arrays in order. */
export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** An AES-256-GCM key from an HKDF base key. The derived key is never extractable. */
export async function deriveAesKey(
  base: CryptoKey,
  { info, salt }: { readonly info: Bytes; readonly salt: Bytes },
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { hash: 'SHA-256', info, name: 'HKDF', salt },
    base,
    { length: 256, name: AES_GCM },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The 32-byte X25519 shared secret. Feed it to HKDF; never use it as a key directly. */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits({ name: X25519, public: publicKey }, privateKey, 256);
  return new Uint8Array(bits);
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

/** A fresh X25519 pair whose private key is not extractable. */
export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: X25519 }, false, ['deriveBits']);
  if (!('privateKey' in pair)) {
    throw new TypeError('X25519 key generation did not return a key pair');
  }
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Imports key material as a non-extractable HKDF base key. */
export async function importHkdfKey(material: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
}

/** Imports 32 raw bytes as an X25519 public key. */
export async function importPublicKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: X25519 }, true, []);
}

/**
 * Decrypts and authenticates a box. Returns null, never throws, when the key, the box or the
 * additional data do not match.
 */
export async function open(
  key: CryptoKey,
  box: SealedBox,
  additionalData: Bytes,
): Promise<Bytes | null> {
  if (box.iv.length !== IV_BYTES || box.authTag.length !== AUTH_TAG_BYTES) {
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { additionalData, iv: box.iv, name: AES_GCM, tagLength: AUTH_TAG_BITS },
      key,
      concatBytes(box.ciphertext, box.authTag),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Encrypts with a fresh random 12-byte IV and splits Web Crypto's `ciphertext || tag` output. */
export async function seal(
  key: CryptoKey,
  plaintext: Bytes,
  additionalData: Bytes,
): Promise<SealedBox> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData, iv, name: AES_GCM, tagLength: AUTH_TAG_BITS },
      key,
      plaintext,
    ),
  );
  const tagStart = sealed.length - AUTH_TAG_BYTES;
  return { authTag: sealed.slice(tagStart), ciphertext: sealed.slice(0, tagStart), iv };
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}
