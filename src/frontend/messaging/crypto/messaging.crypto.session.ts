/**
 * This browser's side of the Sender Keys scheme. It only talks to the injected key store and to the
 * plain async functions it is given, so it never fetches anything on its own.
 */
import type {
  EncryptedPayloadWire,
  MessageView,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';
import type { KeyStore } from './messaging.crypto.key-store.ts';

import { exportPublicKey, generateIdentityKeyPair } from './messaging.crypto.primitives.ts';
import {
  createChainKey,
  decryptMessage,
  encryptMessage,
  unwrapChainKey,
  wrapChainKey,
} from './messaging.crypto.sender-keys.ts';

/** The encrypted fields of a `message.send` frame. */
export type EncryptedMessageFields = EncryptedPayloadWire & {
  readonly chainIndex: number;
  readonly keyEpoch: number;
};

/** Fetches the envelope that wraps `senderId`'s chain key for this user, or null when there is none. */
export type EnvelopeLoader = (
  roomId: string,
  keyEpoch: number,
  senderId: number,
) => Promise<null | SenderKeyEnvelopeView>;

export type EpochMember = {
  readonly publicKeyBase64: string;
  readonly userId: number;
};

/** An envelope to upload. The server adds `senderId` from the authenticated user. */
export type SenderKeyEnvelopeUpload = Omit<SenderKeyEnvelopeView, 'senderId'>;

export class SenderKeySession {
  /** Serializes chain key creation and chain index reservation within this tab. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyStore) {}

  /**
   * Decrypts a stored message. Returns null, never throws, when no chain key is available or the
   * message does not authenticate.
   */
  async decrypt(message: MessageView, loadEnvelope: EnvelopeLoader): Promise<null | string> {
    try {
      const binding = {
        chainIndex: message.chainIndex,
        idempotencyKey: message.idempotencyKey,
        keyEpoch: message.keyEpoch,
        roomId: message.roomId,
        senderId: message.senderId,
      };
      const id = { keyEpoch: message.keyEpoch, roomId: message.roomId, senderId: message.senderId };
      const cached = await this.store.getChainKey(id);
      const fromCache = cached === null ? null : await decryptMessage(cached, binding, message);
      if (fromCache !== null) {
        return fromCache;
      }
      const fresh = await this.unwrapFor(message, loadEnvelope);
      if (fresh === null) {
        return null;
      }
      await this.store.saveChainKey(id, fresh);
      return await decryptMessage(fresh, binding, message);
    } catch {
      return null;
    }
  }

  /**
   * Encrypts one message with this user's chain key for the epoch. The chain index is reserved and
   * persisted before encrypting, so an index is never used twice.
   */
  async encrypt({
    idempotencyKey,
    keyEpoch,
    roomId,
    selfId,
    text,
  }: {
    readonly idempotencyKey: string;
    readonly keyEpoch: number;
    readonly roomId: string;
    readonly selfId: number;
    readonly text: string;
  }): Promise<EncryptedMessageFields> {
    const { chainIndex, chainKey } = await this.exclusive(async () => {
      const key = await this.store.getChainKey({ keyEpoch, roomId, senderId: selfId });
      if (key === null) {
        throw new Error(
          `No own chain key for room ${roomId} epoch ${keyEpoch}; call prepareEpoch first`,
        );
      }
      const next = (await this.store.getNextChainIndex(roomId, keyEpoch)) ?? 0;
      await this.store.saveNextChainIndex(roomId, keyEpoch, next + 1);
      return { chainIndex: next, chainKey: key };
    });
    const payload = await encryptMessage(
      chainKey,
      { chainIndex, idempotencyKey, keyEpoch, roomId, senderId: selfId },
      text,
    );
    return { ...payload, chainIndex, keyEpoch };
  }

  /** Creates the identity pair and publishes its public key the first time; later calls do nothing. */
  async ensureIdentity(publish: (publicKeyBase64: string) => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      if ((await this.store.getIdentity()) !== null) {
        return;
      }
      const identity = await generateIdentityKeyPair();
      const publicKey = await exportPublicKey(identity.publicKey);
      await publish(publicKey.toBase64());
      await this.store.saveIdentity(identity);
    });
  }

  /** Re-pins the given identity keys of the other members: the user trusted them (S5). */
  async trustIdentityKeys({
    members,
    selfId,
  }: {
    readonly members: readonly EpochMember[];
    readonly selfId: number;
  }): Promise<void> {
    await Promise.all(
      members
        .filter(({ userId }) => userId !== selfId)
        .map(async ({ publicKeyBase64, userId }) =>
          this.store.savePinnedKey(userId, publicKeyBase64),
        ),
    );
  }

  /**
   * Trust on first use (S5): pins the identity key of every other member seen for the first time
   * and returns the ids of members whose key differs from their pin. A changed pin is left as it
   * was; only `trustIdentityKeys` replaces it. The own key is never pinned nor compared.
   */
  async verifyIdentityKeys({
    members,
    selfId,
  }: {
    readonly members: readonly EpochMember[];
    readonly selfId: number;
  }): Promise<number[]> {
    const outcomes = await Promise.all(
      members
        .filter(({ userId }) => userId !== selfId)
        .map(async ({ publicKeyBase64, userId }) => {
          const pinned = await this.store.getPinnedKey(userId);
          if (pinned === null) {
            await this.store.savePinnedKey(userId, publicKeyBase64);
            return null;
          }
          return pinned === publicKeyBase64 ? null : userId;
        }),
    );
    return outcomes.filter((userId) => userId !== null);
  }

  /**
   * Creates this user's chain key for the epoch when there is none yet, and returns it wrapped for
   * every member. `members` must include self, so other tabs and reloads can unwrap it. Returns []
   * when the epoch already has an own chain key.
   */
  async prepareEpoch({
    keyEpoch,
    members,
    roomId,
    selfId,
  }: {
    readonly keyEpoch: number;
    readonly members: readonly EpochMember[];
    readonly roomId: string;
    readonly selfId: number;
  }): Promise<SenderKeyEnvelopeUpload[]> {
    return this.exclusive(async () => {
      if ((await this.store.getChainKey({ keyEpoch, roomId, senderId: selfId })) !== null) {
        return [];
      }
      const chain = await createChainKey();
      const envelopes = await Promise.all(
        members.map(async ({ publicKeyBase64, userId }): Promise<SenderKeyEnvelopeUpload> => {
          const wrapped = await wrapChainKey(chain.raw, Uint8Array.fromBase64(publicKeyBase64), {
            keyEpoch,
            recipientId: userId,
            roomId,
            senderId: selfId,
          });
          return { ...wrapped, keyEpoch, recipientId: userId, roomId };
        }),
      );
      chain.raw.fill(0);
      await this.store.saveChainKey({ keyEpoch, roomId, senderId: selfId }, chain.key);
      await this.store.saveNextChainIndex(roomId, keyEpoch, 0);
      return envelopes;
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => null);
    return run;
  }

  private async unwrapFor(
    message: MessageView,
    loadEnvelope: EnvelopeLoader,
  ): Promise<CryptoKey | null> {
    const identity = await this.store.getIdentity();
    if (identity === null) {
      return null;
    }
    const envelope = await loadEnvelope(message.roomId, message.keyEpoch, message.senderId);
    if (envelope === null) {
      return null;
    }
    return unwrapChainKey(envelope, identity, {
      keyEpoch: message.keyEpoch,
      recipientId: envelope.recipientId,
      roomId: message.roomId,
      senderId: message.senderId,
    });
  }
}
