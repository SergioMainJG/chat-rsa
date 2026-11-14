import { describe, expect, test } from 'bun:test';

import { InMemoryKeyStore } from './messaging.crypto.key-store.ts';
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
