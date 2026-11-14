// S5 (finding 4): trust on first use. A server that swaps a member's identity key must never be
// handed this user's chain key: the whole room epoch stays unwrapped until the user trusts the key.
import { describe, expect, test } from 'bun:test';

import type { IdentityKeyView } from '../../../shared/contracts/messaging.contract.ts';
import type { ApiOutcome } from './chat.api.ts';

import { InMemoryKeyStore } from '../crypto/messaging.crypto.key-store.ts';
import { exportPublicKey, generateIdentityKeyPair } from '../crypto/messaging.crypto.primitives.ts';
import { type SenderKeyEnvelopeUpload, SenderKeySession } from '../crypto/messaging.crypto.session.ts';
import { EnvelopeRetryQueue, EpochKeeper } from './chat.epochs.ts';

const ALICE = 1;
const BOB = 2;
const CAROL = 3;

async function publicKey(): Promise<string> {
  const pair = await generateIdentityKeyPair();
  const bytes = await exportPublicKey(pair.publicKey);
  return bytes.toBase64();
}

async function setup(): Promise<{
  readonly identities: Map<string, IdentityKeyView[]>;
  readonly keeper: EpochKeeper;
  readonly keys: Record<'alice' | 'bob' | 'carol' | 'mallory', string>;
  readonly store: InMemoryKeyStore;
  readonly uploads: Array<{ envelopes: readonly SenderKeyEnvelopeUpload[]; keyEpoch: number; roomId: string }>;
}> {
  const keys = {
    alice: await publicKey(),
    bob: await publicKey(),
    carol: await publicKey(),
    mallory: await publicKey(),
  };
  const identities = new Map<string, IdentityKeyView[]>([
    [
      'r1',
      [
        { publicKey: keys.alice, userId: ALICE },
        { publicKey: keys.bob, userId: BOB },
      ],
    ],
    [
      'r2',
      [
        { publicKey: keys.alice, userId: ALICE },
        { publicKey: keys.carol, userId: CAROL },
      ],
    ],
  ]);
  const uploads: Array<{ envelopes: readonly SenderKeyEnvelopeUpload[]; keyEpoch: number; roomId: string }> = [];
  const store = new InMemoryKeyStore();
  const keeper = new EpochKeeper({
    api: {
      roomKeys: async (roomId): Promise<ApiOutcome<IdentityKeyView[]>> => ({
        kind: 'ok',
        value: [...(identities.get(roomId) ?? [])],
      }),
      uploadSenderKeys: async (roomId, keyEpoch, envelopes) => {
        uploads.push({ envelopes, keyEpoch, roomId });
        return { kind: 'ok', value: null };
      },
    },
    crypto: new SenderKeySession(store),
    queue: new EnvelopeRetryQueue(),
    selfId: ALICE,
  });
  return { identities, keeper, keys, store, uploads };
}

describe('EpochKeeper identity key pinning', () => {
  test('first sight pins the other members and wraps the epoch as before', async () => {
    const { keeper, keys, store, uploads } = await setup();

    expect(await keeper.ensureEpoch('r1', 1, [ALICE, BOB])).toBe(true);

    expect(await store.getPinnedKey(BOB)).toBe(keys.bob);
    expect(await store.getPinnedKey(ALICE)).toBeNull();
    expect(uploads.map(({ envelopes }) => envelopes.map(({ recipientId }) => recipientId))).toEqual([[ALICE, BOB]]);
    expect(keeper.changedMembers('r1')).toEqual([]);
  });

  test('the same key on a later epoch keeps wrapping', async () => {
    const { keeper } = await setup();
    await keeper.ensureEpoch('r1', 1, [ALICE, BOB]);

    expect(await keeper.ensureEpoch('r1', 2, [ALICE, BOB])).toBe(true);
    expect(keeper.changedMembers('r1')).toEqual([]);
  });

  test('a changed key wraps nothing for the room, not even for the unchanged members, and leaves other rooms alone', async () => {
    const { identities, keeper, keys, store, uploads } = await setup();
    await keeper.ensureEpoch('r1', 1, [ALICE, BOB]);
    identities.set('r1', [
      { publicKey: keys.alice, userId: ALICE },
      { publicKey: keys.mallory, userId: BOB },
    ]);

    expect(await keeper.ensureEpoch('r1', 2, [ALICE, BOB])).toBe(false);

    expect(keeper.changedMembers('r1')).toEqual([BOB]);
    expect(uploads.filter((upload) => upload.keyEpoch === 2)).toEqual([]);
    expect(await store.getChainKey({ keyEpoch: 2, roomId: 'r1', senderId: ALICE })).toBeNull();
    expect(await store.getPinnedKey(BOB)).toBe(keys.bob);
    expect(await keeper.ensureEpoch('r2', 1, [ALICE, CAROL])).toBe(true);
    expect(keeper.changedMembers('r2')).toEqual([]);
  });

  test('trusting the new key re-pins it and the next ensureEpoch wraps for it', async () => {
    const { identities, keeper, keys, store, uploads } = await setup();
    await keeper.ensureEpoch('r1', 1, [ALICE, BOB]);
    identities.set('r1', [
      { publicKey: keys.alice, userId: ALICE },
      { publicKey: keys.mallory, userId: BOB },
    ]);
    await keeper.ensureEpoch('r1', 2, [ALICE, BOB]);

    await keeper.trustChangedKeys('r1');

    expect(keeper.changedMembers('r1')).toEqual([]);
    expect(await store.getPinnedKey(BOB)).toBe(keys.mallory);
    expect(await keeper.ensureEpoch('r1', 2, [ALICE, BOB])).toBe(true);
    expect(uploads.filter((upload) => upload.keyEpoch === 2).map(({ envelopes }) => envelopes.length)).toEqual([2]);
  });

  test('a key published late is a first sight: pinned without a warning (late identity key path)', async () => {
    const { identities, keeper, keys, store } = await setup();
    identities.set('r1', [{ publicKey: keys.alice, userId: ALICE }]);
    expect(await keeper.ensureEpoch('r1', 1, [ALICE, BOB])).toBe(false);
    expect(keeper.changedMembers('r1')).toEqual([]);

    identities.set('r1', [
      { publicKey: keys.alice, userId: ALICE },
      { publicKey: keys.bob, userId: BOB },
    ]);

    expect(await keeper.ensureEpoch('r1', 1, [ALICE, BOB])).toBe(true);
    expect(await store.getPinnedKey(BOB)).toBe(keys.bob);
    expect(keeper.changedMembers('r1')).toEqual([]);
  });
});
