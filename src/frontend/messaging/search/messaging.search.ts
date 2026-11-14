/**
 * Client-side full-text search. The server only holds ciphertext, so decrypted messages are kept in
 * a local store and searched here.
 */

/** A decrypted message as the local store keeps it. */
export type LocalMessage = {
  /** Server time (ISO 8601). */
  readonly createdAt: string;
  readonly id: string;
  readonly roomId: string;
  readonly senderId: number;
  readonly text: string;
};

export type LocalMessageStore = {
  /** The room's messages, oldest first. */
  listByRoom: (roomId: string) => Promise<LocalMessage[]>;
  /** Inserts, or replaces the message with the same id. */
  put: (message: LocalMessage) => Promise<void>;
  /** Messages matching every query term, newest first; only `roomId`'s when it is given. */
  search: (query: string, roomId?: string) => Promise<LocalMessage[]>;
};

export const MESSAGE_DATABASE = 'chat-rsa.messages';

/** One message database per user: decrypted text never leaks to another account on this browser. */
export function messageDatabaseName(userId: number): string {
  return `${MESSAGE_DATABASE}.${userId}`;
}

const BY_ROOM = 'byRoom';
const COMBINING_MARKS = /\p{M}/gu;
const MESSAGES = 'messages';
const NON_WORD = /[^\p{L}\p{N}]+/u;

/* eslint-disable @typescript-eslint/require-await -- the in-memory adapter answers synchronously but must keep the async port shape */
/** Keeps decrypted messages in memory only: for tests and for browsers without IndexedDB. */
export class InMemoryLocalMessageStore implements LocalMessageStore {
  private readonly messages = new Map<string, LocalMessage>();

  async listByRoom(roomId: string): Promise<LocalMessage[]> {
    return chronological(
      [...this.messages.values()].filter((message) => message.roomId === roomId),
    );
  }

  async put(message: LocalMessage): Promise<void> {
    this.messages.set(message.id, message);
  }

  async search(query: string, roomId?: string): Promise<LocalMessage[]> {
    return searchMessages(this.messages.values(), query, roomId);
  }
}
/* eslint-enable @typescript-eslint/require-await */

/** Database `chat-rsa.messages.<userId>`: one object store keyed by message id, indexed by room. */
export class IndexedDbLocalMessageStore implements LocalMessageStore {
  private database: null | Promise<IDBDatabase> = null;

  constructor(
    private readonly userId: number,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  async listByRoom(roomId: string): Promise<LocalMessage[]> {
    const database = await this.open();
    const index = database.transaction(MESSAGES, 'readonly').objectStore(MESSAGES).index(BY_ROOM);
    const stored = await requestResult(index.getAll(roomId));
    return chronological(stored.filter((value) => isLocalMessage(value)));
  }

  async put(message: LocalMessage): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(MESSAGES, 'readwrite');
    transaction.objectStore(MESSAGES).put(message);
    await transactionDone(transaction);
  }

  async search(query: string, roomId?: string): Promise<LocalMessage[]> {
    const candidates = roomId === undefined ? await this.all() : await this.listByRoom(roomId);
    return searchMessages(candidates, query);
  }

  private async all(): Promise<LocalMessage[]> {
    const database = await this.open();
    const stored = await requestResult(
      database.transaction(MESSAGES, 'readonly').objectStore(MESSAGES).getAll(),
    );
    return stored.filter((value) => isLocalMessage(value));
  }

  private async open(): Promise<IDBDatabase> {
    this.database ??= openDatabase(this.factory, messageDatabaseName(this.userId));
    return this.database;
  }
}

/** True when every query term is a prefix of some word of the text. An empty query matches nothing. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return false;
  }
  const words = tokenize(text);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/** The messages matching `query`, newest first; only `roomId`'s when it is given. */
export function searchMessages(
  messages: Iterable<LocalMessage>,
  query: string,
  roomId?: string,
): LocalMessage[] {
  const matches = [...messages].filter(
    (message) =>
      (roomId === undefined || message.roomId === roomId) && matchesQuery(message.text, query),
  );
  return chronological(matches).toReversed();
}

/** Lowercase words without diacritics, so "Café" and "cafe" are the same token. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replaceAll(COMBINING_MARKS, '')
    .toLowerCase()
    .split(NON_WORD)
    .filter((word) => word.length > 0);
}

/** Oldest first by server time, then by the UUIDv7 id. */
function chronological(messages: readonly LocalMessage[]): LocalMessage[] {
  return messages.toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function isLocalMessage(value: unknown): value is LocalMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'roomId' in value &&
    'text' in value &&
    typeof value.id === 'string' &&
    typeof value.roomId === 'string' &&
    typeof value.text === 'string'
  );
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.addEventListener('upgradeneeded', () => {
    request.result.createObjectStore(MESSAGES, { keyPath: 'id' }).createIndex(BY_ROOM, 'roomId');
  });
  return requestResult(request);
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    });
  });
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      resolve();
    });
    transaction.addEventListener('abort', () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    transaction.addEventListener('error', () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
  });
}
