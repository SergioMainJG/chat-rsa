/**
 * Where this browser keeps its keys. Every `CryptoKey` stored here is non-extractable; IndexedDB
 * stores the key objects themselves (they are structured-cloneable), never their bytes.
 */
import type { IdentityKeyPair } from './messaging.crypto.primitives.ts';

/** One sender's chain key in one room epoch. */
export type ChainKeyId = {
  readonly keyEpoch: number;
  readonly roomId: string;
  readonly senderId: number;
};

export type KeyStore = {
  getChainKey: (id: ChainKeyId) => Promise<CryptoKey | null>;
  getIdentity: () => Promise<IdentityKeyPair | null>;
  /** The chain index this user's next message in the epoch must use, or null before the first one. */
  getNextChainIndex: (roomId: string, keyEpoch: number) => Promise<null | number>;
  /** The identity public key (base64) pinned for another user on first sight (S5), or null. */
  getPinnedKey: (userId: number) => Promise<null | string>;
  saveChainKey: (id: ChainKeyId, key: CryptoKey) => Promise<void>;
  saveIdentity: (identity: IdentityKeyPair) => Promise<void>;
  saveNextChainIndex: (roomId: string, keyEpoch: number, index: number) => Promise<void>;
  /** Pins (or, when the user trusts a new key, re-pins) another user's identity public key. */
  savePinnedKey: (userId: number, publicKeyBase64: string) => Promise<void>;
};

export const KEY_DATABASE = 'chat-rsa.keys';

/** One key database per user, so two accounts on one browser never share an identity (S13). */
export function keyDatabaseName(userId: number): string {
  return `${KEY_DATABASE}.${userId}`;
}

const CHAIN_INDEXES = 'chainIndexes';
const CHAIN_KEYS = 'chainKeys';
const IDENTITY = 'identity';
const IDENTITY_ID = 'self';
const PINNED_KEYS = 'pinnedKeys';
/** Version 2 added PINNED_KEYS. */
const KEY_DATABASE_VERSION = 2;

/** Every object store of the key database. */
export const KEY_STORES: readonly string[] = [CHAIN_INDEXES, CHAIN_KEYS, IDENTITY, PINNED_KEYS];

/** Creates the stores a database opened at an older version lacks; existing stores are kept. */
export function upgradeKeyDatabase(database: {
  readonly createObjectStore: (name: string) => unknown;
  readonly objectStoreNames: Pick<DOMStringList, 'contains'>;
}): void {
  for (const store of KEY_STORES) {
    if (!database.objectStoreNames.contains(store)) {
      database.createObjectStore(store);
    }
  }
}

/* eslint-disable @typescript-eslint/require-await -- the in-memory adapter answers synchronously but must keep the async port shape */
/** Keys in memory only: for tests, and for browsers without IndexedDB (lost on reload). */
export class InMemoryKeyStore implements KeyStore {
  private readonly chainIndexes = new Map<string, number>();
  private readonly chainKeys = new Map<string, CryptoKey>();
  private identity: IdentityKeyPair | null = null;
  private readonly pinnedKeys = new Map<number, string>();

  async getChainKey(id: ChainKeyId): Promise<CryptoKey | null> {
    return this.chainKeys.get(chainKeyIdOf(id)) ?? null;
  }

  async getIdentity(): Promise<IdentityKeyPair | null> {
    return this.identity;
  }

  async getNextChainIndex(roomId: string, keyEpoch: number): Promise<null | number> {
    return this.chainIndexes.get(epochIdOf(roomId, keyEpoch)) ?? null;
  }

  async getPinnedKey(userId: number): Promise<null | string> {
    return this.pinnedKeys.get(userId) ?? null;
  }

  async saveChainKey(id: ChainKeyId, key: CryptoKey): Promise<void> {
    this.chainKeys.set(chainKeyIdOf(id), key);
  }

  async saveIdentity(identity: IdentityKeyPair): Promise<void> {
    this.identity = identity;
  }

  async saveNextChainIndex(roomId: string, keyEpoch: number, index: number): Promise<void> {
    this.chainIndexes.set(epochIdOf(roomId, keyEpoch), index);
  }

  async savePinnedKey(userId: number, publicKeyBase64: string): Promise<void> {
    this.pinnedKeys.set(userId, publicKeyBase64);
  }
}
/* eslint-enable @typescript-eslint/require-await */

/** Database `chat-rsa.keys.<userId>`, one object store per record kind, keyed by string ids. */
export class IndexedDbKeyStore implements KeyStore {
  private database: null | Promise<IDBDatabase> = null;

  constructor(
    private readonly userId: number,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  async getChainKey(id: ChainKeyId): Promise<CryptoKey | null> {
    const value = await this.get(CHAIN_KEYS, chainKeyIdOf(id));
    return value instanceof CryptoKey ? value : null;
  }

  async getIdentity(): Promise<IdentityKeyPair | null> {
    const value = await this.get(IDENTITY, IDENTITY_ID);
    return isIdentity(value) ? value : null;
  }

  async getNextChainIndex(roomId: string, keyEpoch: number): Promise<null | number> {
    const value = await this.get(CHAIN_INDEXES, epochIdOf(roomId, keyEpoch));
    return typeof value === 'number' ? value : null;
  }

  async getPinnedKey(userId: number): Promise<null | string> {
    const value = await this.get(PINNED_KEYS, String(userId));
    return typeof value === 'string' ? value : null;
  }

  async saveChainKey(id: ChainKeyId, key: CryptoKey): Promise<void> {
    await this.put(CHAIN_KEYS, chainKeyIdOf(id), key);
  }

  async saveIdentity(identity: IdentityKeyPair): Promise<void> {
    await this.put(IDENTITY, IDENTITY_ID, {
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
    });
  }

  async saveNextChainIndex(roomId: string, keyEpoch: number, index: number): Promise<void> {
    await this.put(CHAIN_INDEXES, epochIdOf(roomId, keyEpoch), index);
  }

  async savePinnedKey(userId: number, publicKeyBase64: string): Promise<void> {
    await this.put(PINNED_KEYS, String(userId), publicKeyBase64);
  }

  private async get(store: string, key: string): Promise<unknown> {
    const database = await this.open();
    return requestResult(database.transaction(store, 'readonly').objectStore(store).get(key));
  }

  private async open(): Promise<IDBDatabase> {
    this.database ??= openDatabase(this.factory, keyDatabaseName(this.userId));
    return this.database;
  }

  private async put(store: string, key: string, value: unknown): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value, key);
    await transactionDone(transaction);
  }
}

function chainKeyIdOf({ keyEpoch, roomId, senderId }: ChainKeyId): string {
  return JSON.stringify([roomId, keyEpoch, senderId]);
}

function epochIdOf(roomId: string, keyEpoch: number): string {
  return JSON.stringify([roomId, keyEpoch]);
}

function isIdentity(value: unknown): value is IdentityKeyPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    'privateKey' in value &&
    'publicKey' in value &&
    value.privateKey instanceof CryptoKey &&
    value.publicKey instanceof CryptoKey
  );
}

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, KEY_DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    upgradeKeyDatabase(request.result);
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
