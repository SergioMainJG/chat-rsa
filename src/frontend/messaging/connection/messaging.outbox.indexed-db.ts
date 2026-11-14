// Browser adapter of the Outbox port. It is not unit-tested (Bun has no IndexedDB); the queue
// rules are tested on InMemoryOutbox, and this file only maps them onto object-store calls.
import type { Outbox, OutboxItem } from './messaging.outbox.ts';

const DATABASE = 'chat-rsa.outbox';

/**
 * One outbox per user. A shared one let another account's tab flush this user's queued plaintext as
 * its own message, under its own sender id.
 */
export function outboxDatabaseName(userId: number): string {
  return `${DATABASE}.${userId}`;
}
const KEY_INDEX = 'idempotencyKey';
const STORE = 'items';
const VERSION = 1;

/** Stored row: the auto-incremented `seq` primary key keeps enqueue order (stable FIFO). */
type Row = OutboxItem & { readonly seq?: number };

/**
 * Outbox persisted in IndexedDB, so messages written offline survive a reload. Each method runs in
 * its own transaction.
 */
export class IndexedDbOutbox implements Outbox {
  readonly #database: IDBDatabase;

  constructor(database: IDBDatabase) {
    this.#database = database;
  }

  enqueue = async (item: OutboxItem): Promise<void> => {
    const store = this.#store('readwrite');
    const existing = await request(store.index(KEY_INDEX).getKey(item.idempotencyKey));
    if (existing === undefined) {
      await request(store.add(toRow(item)));
    }
  };

  get = async (idempotencyKey: string): Promise<null | OutboxItem> => {
    const pending: IDBRequest<unknown> = this.#store('readonly')
      .index(KEY_INDEX)
      .get(idempotencyKey);
    const row = await request(pending);
    return isRow(row) ? toItem(row) : null;
  };

  list = async (): Promise<readonly OutboxItem[]> => {
    const pending: IDBRequest<unknown[]> = this.#store('readonly').getAll();
    const rows = await request(pending);
    return rows.filter((row) => isRow(row)).map((row) => toItem(row));
  };

  remove = async (idempotencyKey: string): Promise<void> => {
    const store = this.#store('readwrite');
    const seq = await request(store.index(KEY_INDEX).getKey(idempotencyKey));
    if (seq !== undefined) {
      await request(store.delete(seq));
    }
  };

  #store(mode: IDBTransactionMode): IDBObjectStore {
    return this.#database.transaction(STORE, mode).objectStore(STORE);
  }
}

/** Opens (and on first use creates) the user's `chat-rsa.outbox.<userId>` database. */
export async function openIndexedDbOutbox(
  userId: number,
  factory: IDBFactory = indexedDB,
): Promise<IndexedDbOutbox> {
  const opening = factory.open(outboxDatabaseName(userId), VERSION);
  opening.addEventListener('upgradeneeded', () => {
    const store = opening.result.createObjectStore(STORE, { autoIncrement: true, keyPath: 'seq' });
    store.createIndex(KEY_INDEX, KEY_INDEX, { unique: true });
  });
  return new IndexedDbOutbox(await request(opening));
}

function isRow(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    'idempotencyKey' in value &&
    typeof value.idempotencyKey === 'string' &&
    'queuedAt' in value &&
    typeof value.queuedAt === 'string' &&
    'roomId' in value &&
    typeof value.roomId === 'string' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

async function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.addEventListener('success', () => {
      resolve(pending.result);
    });
    pending.addEventListener('error', () => {
      reject(pending.error ?? new Error('IndexedDB request failed'));
    });
  });
}

function toItem({ idempotencyKey, queuedAt, roomId, text }: Row): OutboxItem {
  return { idempotencyKey, queuedAt, roomId, text };
}

function toRow(item: OutboxItem): Row {
  const { idempotencyKey, queuedAt, roomId, text } = item;
  return { idempotencyKey, queuedAt, roomId, text };
}
