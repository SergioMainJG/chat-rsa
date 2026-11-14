/** Base64 parts of an AES-256-GCM output. The server stores them without decrypting. */
export type EncryptedPayloadWire = {
  readonly authTag: string;
  readonly ciphertext: string;
  readonly iv: string;
};

export type HistoryPage = {
  readonly messages: readonly MessageView[];
  /** Pass as `before` to load the next older page; null when there is nothing older. */
  readonly nextBefore: null | string;
};

export type IdentityKeyView = {
  readonly publicKey: string;
  readonly userId: number;
};

export type MessageStatus = 'delivered' | 'read' | 'sent';

/** A stored message as clients receive it, over REST history or a WebSocket frame. */
export type MessageView = EncryptedPayloadWire & {
  readonly chainIndex: number;
  /** Server time (ISO 8601) derived from the UUIDv7 id. */
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly keyEpoch: number;
  readonly roomId: string;
  readonly senderId: number;
};

export type RoomSummary = {
  readonly id: string;
  readonly keyEpoch: number;
  readonly memberIds: readonly number[];
  readonly name: string;
};

/** A sender's chain key for one epoch, wrapped for one recipient (X25519 + HKDF + AES-GCM). */
export type SenderKeyEnvelopeView = EncryptedPayloadWire & {
  readonly ephemeralPublicKey: string;
  readonly keyEpoch: number;
  readonly recipientId: number;
  readonly roomId: string;
  readonly senderId: number;
};
