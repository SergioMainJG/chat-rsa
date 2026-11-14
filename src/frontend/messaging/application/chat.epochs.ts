/**
 * Sender Keys distribution for the page (S14). `SenderKeySession.prepareEpoch` saves this user's
 * chain key before the envelopes are uploaded and returns [] on later calls, so a failed upload can
 * only be repaired by retrying the batch it returned: the batch is kept here and retried before the
 * next send.
 */
import type {
  IdentityKeyView,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';
import type { EpochMember, SenderKeyEnvelopeUpload } from '../crypto/messaging.crypto.session.ts';
import type { ApiOutcome } from './chat.api.ts';

export type EnvelopeBatch = {
  readonly envelopes: readonly SenderKeyEnvelopeUpload[];
  readonly keyEpoch: number;
  readonly roomId: string;
};

export type EpochKeeperDeps = {
  readonly api: {
    readonly roomKeys: (roomId: string) => Promise<ApiOutcome<IdentityKeyView[]>>;
    readonly uploadSenderKeys: (
      roomId: string,
      keyEpoch: number,
      envelopes: readonly SenderKeyEnvelopeUpload[],
    ) => Promise<ApiOutcome<null>>;
  };
  readonly crypto: {
    readonly prepareEpoch: (input: {
      readonly keyEpoch: number;
      readonly members: readonly EpochMember[];
      readonly roomId: string;
      readonly selfId: number;
    }) => Promise<SenderKeyEnvelopeUpload[]>;
  };
  readonly queue: EnvelopeRetryQueue;
  readonly selfId: number;
};

function epochKey(roomId: string, keyEpoch: number): string {
  return `${roomId}:${keyEpoch}`;
}

/**
 * Envelopes addressed to this user, fetched once per room epoch: the `EnvelopeLoader` that
 * `SenderKeySession.decrypt` needs. `invalidate` (on `sender-keys.available`) refetches the epoch.
 */
export class EnvelopeCache {
  readonly #epochs = new Map<string, Promise<null | readonly SenderKeyEnvelopeView[]>>();
  readonly #fetch: (
    roomId: string,
    keyEpoch: number,
  ) => Promise<ApiOutcome<SenderKeyEnvelopeView[]>>;

  constructor(
    fetchEpoch: (roomId: string, keyEpoch: number) => Promise<ApiOutcome<SenderKeyEnvelopeView[]>>,
  ) {
    this.#fetch = fetchEpoch;
  }

  invalidate(roomId: string, keyEpoch: number): void {
    this.#epochs.delete(epochKey(roomId, keyEpoch));
  }

  /** The envelope wrapping `senderId`'s chain key for this user, or null. */
  load = async (
    roomId: string,
    keyEpoch: number,
    senderId: number,
  ): Promise<null | SenderKeyEnvelopeView> => {
    const key = epochKey(roomId, keyEpoch);
    let pending = this.#epochs.get(key);
    if (!pending) {
      pending = this.#fetchEpoch(roomId, keyEpoch);
      this.#epochs.set(key, pending);
    }
    const envelopes = await pending;
    if (envelopes === null) {
      // Failures are not cached: the next message of the epoch asks again.
      if (this.#epochs.get(key) === pending) {
        this.#epochs.delete(key);
      }
      return null;
    }
    return envelopes.find((envelope) => envelope.senderId === senderId) ?? null;
  };

  async #fetchEpoch(
    roomId: string,
    keyEpoch: number,
  ): Promise<null | readonly SenderKeyEnvelopeView[]> {
    const outcome = await this.#fetch(roomId, keyEpoch);
    return outcome.kind === 'ok' ? outcome.value : null;
  }
}

/** Envelope batches whose upload failed, one per room epoch, in the order they failed. */
export class EnvelopeRetryQueue {
  get size(): number {
    return this.#batches.size;
  }

  readonly #batches = new Map<string, EnvelopeBatch>();

  add(batch: EnvelopeBatch): void {
    this.#batches.set(epochKey(batch.roomId, batch.keyEpoch), batch);
  }

  has(roomId: string, keyEpoch: number): boolean {
    return this.#batches.has(epochKey(roomId, keyEpoch));
  }

  list(): EnvelopeBatch[] {
    return [...this.#batches.values()];
  }

  remove(roomId: string, keyEpoch: number): void {
    this.#batches.delete(epochKey(roomId, keyEpoch));
  }
}

/**
 * Makes sure this user's chain key for a room epoch exists and reached every member: on `ready`, on
 * room open, on `room.rotated`, and before each send. Calls are serialized, so two triggers never
 * upload the same batch twice at once.
 */
export class EpochKeeper {
  readonly #deps: EpochKeeperDeps;
  readonly #prepared = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: EpochKeeperDeps) {
    this.#deps = deps;
  }

  /**
   * True when the epoch has an own chain key whose envelopes were uploaded. Stored batches are
   * retried first; false means sending must wait (the outbox keeps the message).
   *
   * `memberIds` are the room's members. While one of them has not published an identity key yet,
   * nothing is prepared and the result is false: the chain key is non-extractable once created, so
   * a member left out of the first batch could never be given an envelope for this epoch (S4).
   */
  async ensureEpoch(
    roomId: string,
    keyEpoch: number,
    memberIds: readonly number[] = [],
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      await this.#retryAll();
      const key = epochKey(roomId, keyEpoch);
      if (!this.#prepared.has(key)) {
        const keys = await this.#deps.api.roomKeys(roomId);
        if (keys.kind !== 'ok') {
          return false;
        }
        const published = new Set(keys.value.map(({ userId }) => userId));
        if (memberIds.some((memberId) => !published.has(memberId))) {
          return false;
        }
        const envelopes = await this.#deps.crypto.prepareEpoch({
          keyEpoch,
          members: keys.value.map(({ publicKey, userId }) => ({
            publicKeyBase64: publicKey,
            userId,
          })),
          roomId,
          selfId: this.#deps.selfId,
        });
        this.#prepared.add(key);
        if (envelopes.length > 0) {
          await this.#upload({ envelopes, keyEpoch, roomId });
        }
      }
      return !this.#deps.queue.has(roomId, keyEpoch);
    });
  }

  /** Drops what is known about the epoch, e.g. when an encrypt found no own chain key. */
  forget(roomId: string, keyEpoch: number): void {
    this.#prepared.delete(epochKey(roomId, keyEpoch));
  }

  /** Retries every stored batch; true when none is left. */
  async retryPending(): Promise<boolean> {
    return this.#exclusive(async () => {
      await this.#retryAll();
      return this.#deps.queue.size === 0;
    });
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => null);
    return run;
  }

  async #retryAll(): Promise<void> {
    // Sequential on purpose: batches go out in the order they failed.
    for (const batch of this.#deps.queue.list()) {
      // eslint-disable-next-line no-await-in-loop -- uploads are ordered, one at a time
      await this.#upload(batch);
    }
  }

  async #upload(batch: EnvelopeBatch): Promise<void> {
    const outcome = await this.#deps.api.uploadSenderKeys(
      batch.roomId,
      batch.keyEpoch,
      batch.envelopes,
    );
    if (outcome.kind === 'ok') {
      this.#deps.queue.remove(batch.roomId, batch.keyEpoch);
    } else {
      this.#deps.queue.add(batch);
    }
  }
}
