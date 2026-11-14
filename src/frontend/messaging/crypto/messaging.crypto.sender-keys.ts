/**
 * Sender Keys: every sender has one random chain key per (room, key epoch). Each message is
 * encrypted once with a key derived from that chain key and its chain index, and the chain key is
 * wrapped once per room member with X25519 + HKDF + AES-GCM. A new epoch (member join or leave)
 * means a new chain key, so removed members cannot read what comes after.
 */
import type { EncryptedPayloadWire } from '../../../shared/contracts/messaging.contract.ts';

import {
  type Bytes,
  concatBytes,
  deriveAesKey,
  deriveSharedSecret,
  exportPublicKey,
  generateIdentityKeyPair,
  type IdentityKeyPair,
  importHkdfKey,
  importPublicKey,
  open,
  randomBytes,
  seal,
  type SealedBox,
  utf8,
} from './messaging.crypto.primitives.ts';

/** What the server must not be able to swap: AES-GCM authenticates all of it. */
export type EnvelopeBinding = {
  readonly keyEpoch: number;
  readonly recipientId: number;
  readonly roomId: string;
  readonly senderId: number;
};

export type MessageBinding = {
  readonly chainIndex: number;
  readonly idempotencyKey: string;
  readonly keyEpoch: number;
  readonly roomId: string;
  readonly senderId: number;
};

/** A freshly created chain key. Keep `raw` only long enough to wrap it for the room members. */
export type NewChainKey = {
  readonly key: CryptoKey;
  readonly raw: Bytes;
};

/** A chain key wrapped for one recipient; `SenderKeyEnvelopeView` without the routing fields. */
export type WrappedChainKey = EncryptedPayloadWire & {
  readonly ephemeralPublicKey: string;
};

export const CHAIN_KEY_BYTES = 32;

const ENVELOPE_INFO = 'chat-rsa/sender-key/v1';
const MESSAGE_AD = 'chat-rsa/message-ad/v1';
const MESSAGE_INFO = 'chat-rsa/message/v1';
const NO_SALT = new Uint8Array(0);

/** A random chain key, imported as a non-extractable HKDF base key. */
export async function createChainKey(): Promise<NewChainKey> {
  const raw = randomBytes(CHAIN_KEY_BYTES);
  return { key: await importHkdfKey(raw), raw };
}

/** The plaintext, or null when the key, the payload or the binding do not match. */
export async function decryptMessage(
  chainKey: CryptoKey,
  binding: MessageBinding,
  payload: EncryptedPayloadWire,
): Promise<null | string> {
  const box = boxOf(payload);
  if (box === null) {
    return null;
  }
  const plain = await open(
    await messageKey(chainKey, binding),
    box,
    messageAdditionalData(binding),
  );
  return plain === null ? null : new TextDecoder().decode(plain);
}

export async function encryptMessage(
  chainKey: CryptoKey,
  binding: MessageBinding,
  text: string,
): Promise<EncryptedPayloadWire> {
  const box = await seal(
    await messageKey(chainKey, binding),
    utf8(text),
    messageAdditionalData(binding),
  );
  return wireOf(box);
}

/**
 * Unwraps a chain key with this user's identity. Returns null, never throws, when the envelope was
 * made for someone else, under another binding, or was tampered with.
 */
export async function unwrapChainKey(
  wrapped: WrappedChainKey,
  identity: IdentityKeyPair,
  binding: EnvelopeBinding,
): Promise<CryptoKey | null> {
  const ephemeralPublic = decodeBase64(wrapped.ephemeralPublicKey);
  const box = boxOf(wrapped);
  if (ephemeralPublic === null || box === null) {
    return null;
  }
  try {
    const shared = await deriveSharedSecret(
      identity.privateKey,
      await importPublicKey(ephemeralPublic),
    );
    const recipientPublic = await exportPublicKey(identity.publicKey);
    const key = await envelopeKey(shared, ephemeralPublic, recipientPublic, binding);
    const raw = await open(key, box, envelopeInfo(binding));
    return raw?.length === CHAIN_KEY_BYTES ? await importHkdfKey(raw) : null;
  } catch {
    return null;
  }
}

/** Wraps a chain key for one recipient with a fresh ephemeral X25519 pair. */
export async function wrapChainKey(
  chainKey: Bytes,
  recipientPublicKey: Bytes,
  binding: EnvelopeBinding,
): Promise<WrappedChainKey> {
  const ephemeral = await generateIdentityKeyPair();
  const ephemeralPublic = await exportPublicKey(ephemeral.publicKey);
  const shared = await deriveSharedSecret(
    ephemeral.privateKey,
    await importPublicKey(recipientPublicKey),
  );
  const key = await envelopeKey(shared, ephemeralPublic, recipientPublicKey, binding);
  const box = await seal(key, chainKey, envelopeInfo(binding));
  return { ...wireOf(box), ephemeralPublicKey: ephemeralPublic.toBase64() };
}

function boxOf(payload: EncryptedPayloadWire): null | SealedBox {
  const authTag = decodeBase64(payload.authTag);
  const ciphertext = decodeBase64(payload.ciphertext);
  const iv = decodeBase64(payload.iv);
  return authTag === null || ciphertext === null || iv === null
    ? null
    : { authTag, ciphertext, iv };
}

/** Length-delimited (JSON) so no two different field lists encode to the same bytes. */
function context(label: string, ...parts: ReadonlyArray<number | string>): Bytes {
  return utf8(JSON.stringify([label, ...parts]));
}

function decodeBase64(text: string): Bytes | null {
  try {
    return Uint8Array.fromBase64(text, { lastChunkHandling: 'strict' });
  } catch {
    return null;
  }
}

function envelopeInfo({ keyEpoch, recipientId, roomId, senderId }: EnvelopeBinding): Bytes {
  return context(ENVELOPE_INFO, roomId, keyEpoch, senderId, recipientId);
}

async function envelopeKey(
  shared: Bytes,
  ephemeralPublic: Bytes,
  recipientPublic: Bytes,
  binding: EnvelopeBinding,
): Promise<CryptoKey> {
  return deriveAesKey(await importHkdfKey(shared), {
    info: envelopeInfo(binding),
    salt: concatBytes(ephemeralPublic, recipientPublic),
  });
}

function messageAdditionalData({
  chainIndex,
  idempotencyKey,
  keyEpoch,
  roomId,
  senderId,
}: MessageBinding): Bytes {
  return context(MESSAGE_AD, roomId, senderId, keyEpoch, chainIndex, idempotencyKey);
}

/** Random access: the key for index i depends only on the chain key and the binding, not on i - 1. */
async function messageKey(
  chainKey: CryptoKey,
  { chainIndex, keyEpoch, roomId, senderId }: MessageBinding,
): Promise<CryptoKey> {
  return deriveAesKey(chainKey, {
    info: context(MESSAGE_INFO, roomId, keyEpoch, senderId, chainIndex),
    salt: NO_SALT,
  });
}

function wireOf(box: SealedBox): EncryptedPayloadWire {
  return {
    authTag: box.authTag.toBase64(),
    ciphertext: box.ciphertext.toBase64(),
    iv: box.iv.toBase64(),
  };
}
