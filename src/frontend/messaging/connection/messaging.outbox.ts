/**
 * A message waiting to be sent. It holds the plaintext, not ciphertext: the room's key epoch may
 * rotate while the user is offline, so encryption happens when the item is flushed.
 */
export type OutboxItem = {
  /** `crypto.randomUUID()`, reused on every retry so the server stores the message once. */
  readonly idempotencyKey: string;
  /** Client time (ISO 8601), for display only; the server assigns the canonical time. */
  readonly queuedAt: string;
  readonly roomId: string;
  readonly text: string;
};

/** Durable queue of unsent messages (S9). */
export type Outbox = {
  /** Appends the item; an item whose key is already queued is left as it was. */
  readonly enqueue: (item: OutboxItem) => Promise<void>;
  readonly get: (idempotencyKey: string) => Promise<null | OutboxItem>;
  /** Every queued item, oldest first, in enqueue order. */
  readonly list: () => Promise<readonly OutboxItem[]>;
  readonly remove: (idempotencyKey: string) => Promise<void>;
};

/** Outbox kept in memory: for tests, and as a fallback where IndexedDB is unavailable. */
export class InMemoryOutbox implements Outbox {
  readonly #items: OutboxItem[] = [];

  // Each method yields once, like a real store, so callers cannot rely on synchronous completion.
  enqueue = async (item: OutboxItem): Promise<void> => {
    await Promise.resolve();
    if (!this.#items.some((queued) => queued.idempotencyKey === item.idempotencyKey)) {
      this.#items.push(item);
    }
  };

  get = async (idempotencyKey: string): Promise<null | OutboxItem> => {
    await Promise.resolve();
    return this.#items.find((item) => item.idempotencyKey === idempotencyKey) ?? null;
  };

  list = async (): Promise<readonly OutboxItem[]> => {
    await Promise.resolve();
    return [...this.#items];
  };

  remove = async (idempotencyKey: string): Promise<void> => {
    await Promise.resolve();
    const index = this.#items.findIndex((item) => item.idempotencyKey === idempotencyKey);
    if (index !== -1) {
      this.#items.splice(index, 1);
    }
  };
}

export function newOutboxItem(
  roomId: string,
  text: string,
  clock: { readonly now: () => number; readonly randomUUID: () => string },
): OutboxItem {
  return {
    idempotencyKey: clock.randomUUID(),
    queuedAt: new Date(clock.now()).toISOString(),
    roomId,
    text,
  };
}
