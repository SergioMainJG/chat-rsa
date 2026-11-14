import { describe, expect, test } from 'bun:test';

import { InMemoryKeyStore, KEY_STORES, upgradeKeyDatabase } from './messaging.crypto.key-store.ts';
import { generateIdentityKeyPair } from './messaging.crypto.primitives.ts';
import { createChainKey } from './messaging.crypto.sender-keys.ts';

const ROOM = '019a0000-0000-7000-8000-000000000001';

describe('InMemoryKeyStore', () => {
  test('returns null for everything before anything is saved', async () => {
    const store = new InMemoryKeyStore();

    expect(await store.getIdentity()).toBeNull();
    expect(await store.getChainKey({ keyEpoch: 1, roomId: ROOM, senderId: 7 })).toBeNull();
    expect(await store.getNextChainIndex(ROOM, 1)).toBeNull();
  });

  test('keeps the saved identity pair', async () => {
    const store = new InMemoryKeyStore();
    const identity = await generateIdentityKeyPair();

    await store.saveIdentity(identity);

    expect(await store.getIdentity()).toBe(identity);
  });

  test('keys chain keys by room, epoch and sender', async () => {
    const store = new InMemoryKeyStore();
    const { key } = await createChainKey();

    await store.saveChainKey({ keyEpoch: 1, roomId: ROOM, senderId: 7 }, key);

    expect(await store.getChainKey({ keyEpoch: 1, roomId: ROOM, senderId: 7 })).toBe(key);
    expect(await store.getChainKey({ keyEpoch: 2, roomId: ROOM, senderId: 7 })).toBeNull();
    expect(await store.getChainKey({ keyEpoch: 1, roomId: ROOM, senderId: 8 })).toBeNull();
  });

  test('keys the next own chain index by room and epoch', async () => {
    const store = new InMemoryKeyStore();

    await store.saveNextChainIndex(ROOM, 1, 5);

    expect(await store.getNextChainIndex(ROOM, 1)).toBe(5);
    expect(await store.getNextChainIndex(ROOM, 2)).toBeNull();
  });
});

describe('pinned identity keys (S5)', () => {
  test('are null before the first sight and kept per peer user afterwards', async () => {
    const store = new InMemoryKeyStore();
    expect(await store.getPinnedKey(2)).toBeNull();

    await store.savePinnedKey(2, 'pk2');
    await store.savePinnedKey(3, 'pk3');

    expect(await store.getPinnedKey(2)).toBe('pk2');
    expect(await store.getPinnedKey(3)).toBe('pk3');
  });

  test('a later save replaces the pin (trusting a new key)', async () => {
    const store = new InMemoryKeyStore();
    await store.savePinnedKey(2, 'old');

    await store.savePinnedKey(2, 'new');

    expect(await store.getPinnedKey(2)).toBe('new');
  });
});

/** The part of IDBDatabase the upgrade touches. */
function fakeDatabase(existing: readonly string[]): {
  created: string[];
  database: Parameters<typeof upgradeKeyDatabase>[0];
} {
  const names = new Set(existing);
  const created: string[] = [];
  return {
    created,
    database: {
      createObjectStore: (name: string) => {
        names.add(name);
        created.push(name);
      },
      objectStoreNames: { contains: (name: string) => names.has(name) },
    },
  };
}

describe('upgradeKeyDatabase', () => {
  test('a new database gets every store', () => {
    const { created, database } = fakeDatabase([]);

    upgradeKeyDatabase(database);

    expect(created.toSorted()).toEqual([...KEY_STORES].toSorted());
    expect(created).toContain('pinnedKeys');
  });

  test('a version 1 database keeps its stores and only gains the pinned keys store', () => {
    const { created, database } = fakeDatabase(['chainIndexes', 'chainKeys', 'identity']);

    upgradeKeyDatabase(database);

    expect(created).toEqual(['pinnedKeys']);
  });
});
