import { describe, expect, test } from 'bun:test';

import type { MessageView, SenderKeyEnvelopeView } from '../../../shared/contracts/messaging.contract.ts';

import { InMemoryKeyStore } from './messaging.crypto.key-store.ts';
import { decryptMessage, unwrapChainKey } from './messaging.crypto.sender-keys.ts';
import { type EnvelopeLoader, type SenderKeyEnvelopeUpload, SenderKeySession } from './messaging.crypto.session.ts';

const ROOM = '019a0000-0000-7000-8000-000000000001';
const ALICE = 1;
const BOB = 2;

type Member = {
  readonly id: number;
  readonly publicKeyBase64: string;
  readonly session: SenderKeySession;
  readonly store: InMemoryKeyStore;
};

/** Plays the server: keeps uploaded envelopes and serves them back by (room, epoch, sender, recipient). */
class FakeServer {
  private readonly envelopes: SenderKeyEnvelopeView[] = [];

  loaderFor(recipientId: number): EnvelopeLoader {
    return async (roomId, keyEpoch, senderId) =>
      this.envelopes.find(
        (envelope) =>
          envelope.roomId === roomId &&
          envelope.keyEpoch === keyEpoch &&
          envelope.senderId === senderId &&
          envelope.recipientId === recipientId,
      ) ?? null;
  }

  upload(senderId: number, uploads: readonly SenderKeyEnvelopeUpload[]): void {
    for (const upload of uploads) {
      this.envelopes.push({ ...upload, senderId });
    }
  }
}

async function member(id: number, store = new InMemoryKeyStore()): Promise<Member> {
  const session = new SenderKeySession(store);
  let publicKeyBase64 = '';
  await session.ensureIdentity(async (published) => {
    publicKeyBase64 = published;
  });
  return { id, publicKeyBase64, session, store };
}

function roster(...members: readonly Member[]): Array<{ publicKeyBase64: string; userId: number }> {
  return members.map(({ id, publicKeyBase64 }) => ({ publicKeyBase64, userId: id }));
}

function view(
  frame: Awaited<ReturnType<SenderKeySession['encrypt']>>,
  overrides: Partial<MessageView> & { readonly idempotencyKey: string; readonly senderId: number },
): MessageView {
  return {
    ...frame,
    createdAt: '2026-11-12T00:00:00.000Z',
    id: '019a0000-0000-7000-8000-0000000000f0',
    roomId: ROOM,
    ...overrides,
  };
}

describe('SenderKeySession.ensureIdentity', () => {
  test('creates and publishes the identity once', async () => {
    const session = new SenderKeySession(new InMemoryKeyStore());
    const published: string[] = [];
    const publish = async (key: string): Promise<void> => {
      published.push(key);
    };

    await session.ensureIdentity(publish);
    await session.ensureIdentity(publish);

    expect(published).toHaveLength(1);
    expect(Uint8Array.fromBase64(published[0] ?? '')).toHaveLength(32);
  });

  test('does not keep an identity whose publication failed', async () => {
    const store = new InMemoryKeyStore();
    const session = new SenderKeySession(store);

    const outcome = await session
      .ensureIdentity(async () => {
        throw new Error('offline');
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );

    expect(outcome).toBe('rejected');
    expect(await store.getIdentity()).toBeNull();
  });
});

describe('SenderKeySession.prepareEpoch', () => {
  test('returns one envelope per member, including self, and nothing the second time', async () => {
    const alice = await member(ALICE);
    const bob = await member(BOB);
    const epoch = { keyEpoch: 1, members: roster(alice, bob), roomId: ROOM, selfId: ALICE };

    const first = await alice.session.prepareEpoch(epoch);
    const second = await alice.session.prepareEpoch(epoch);

    expect(first.map((envelope) => envelope.recipientId).toSorted((a, b) => a - b)).toEqual([ALICE, BOB]);
    expect(first.every((envelope) => envelope.roomId === ROOM && envelope.keyEpoch === 1)).toBe(true);
    expect(second).toEqual([]);
  });

  test('a new epoch uses a different chain key', async () => {
    const alice = await member(ALICE);
    const bob = await member(BOB);
    const identity = await bob.store.getIdentity();
    const prepared = await alice.session.prepareEpoch({
      keyEpoch: 1,
      members: roster(alice, bob),
      roomId: ROOM,
      selfId: ALICE,
    });
    const epochOne = prepared.find((envelope) => envelope.recipientId === BOB);
    await alice.session.prepareEpoch({ keyEpoch: 2, members: roster(alice, bob), roomId: ROOM, selfId: ALICE });
    const frame = await alice.session.encrypt({
      idempotencyKey: 'k-2',
      keyEpoch: 2,
      roomId: ROOM,
      selfId: ALICE,
      text: 'after rotation',
    });

    expect(identity).not.toBeNull();
    expect(epochOne).toBeDefined();
    if (identity === null || epochOne === undefined) {
      return;
    }
    const oldKey = await unwrapChainKey(epochOne, identity, {
      keyEpoch: 1,
      recipientId: BOB,
      roomId: ROOM,
      senderId: ALICE,
    });
    expect(oldKey).not.toBeNull();
    if (oldKey !== null) {
      const binding = { ...frame, idempotencyKey: 'k-2', roomId: ROOM, senderId: ALICE };
      expect(await decryptMessage(oldKey, binding, frame)).toBeNull();
    }
  });
});

describe('SenderKeySession.encrypt', () => {
  test('never reuses a chain index, across calls, concurrent calls and new sessions', async () => {
    const alice = await member(ALICE);
    await alice.session.prepareEpoch({ keyEpoch: 1, members: roster(alice), roomId: ROOM, selfId: ALICE });
    const send = async (session: SenderKeySession, key: string): Promise<number> => {
      const frame = await session.encrypt({ idempotencyKey: key, keyEpoch: 1, roomId: ROOM, selfId: ALICE, text: 'x' });
      return frame.chainIndex;
    };

    const first = await send(alice.session, 'a');
    const second = await send(alice.session, 'b');
    const concurrent = await Promise.all(['c', 'd', 'e'].map(async (key) => send(alice.session, key)));
    const afterReload = await send(new SenderKeySession(alice.store), 'f');

    const indexes = [first, second, ...concurrent, afterReload];
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('refuses to encrypt before the epoch has an own chain key', async () => {
    const alice = await member(ALICE);

    const outcome = await alice.session
      .encrypt({ idempotencyKey: 'k', keyEpoch: 1, roomId: ROOM, selfId: ALICE, text: 'x' })
      .then(
        () => 'resolved',
        () => 'rejected',
      );

    expect(outcome).toBe('rejected');
  });
});

describe('SenderKeySession.decrypt', () => {
  test('a member decrypts a message with the envelope the sender uploaded', async () => {
    const server = new FakeServer();
    const alice = await member(ALICE);
    const bob = await member(BOB);
    server.upload(
      ALICE,
      await alice.session.prepareEpoch({ keyEpoch: 1, members: roster(alice, bob), roomId: ROOM, selfId: ALICE }),
    );

    const frame = await alice.session.encrypt({
      idempotencyKey: 'k-1',
      keyEpoch: 1,
      roomId: ROOM,
      selfId: ALICE,
      text: 'hola Bob',
    });
    const message = view(frame, { idempotencyKey: 'k-1', senderId: ALICE });

    expect(await bob.session.decrypt(message, server.loaderFor(BOB))).toBe('hola Bob');
    expect(await bob.session.decrypt(message, async () => null)).toBe('hola Bob');
  });

  test('the sender reads its own messages after a reload through its self envelope', async () => {
    const server = new FakeServer();
    const alice = await member(ALICE);
    server.upload(
      ALICE,
      await alice.session.prepareEpoch({ keyEpoch: 1, members: roster(alice), roomId: ROOM, selfId: ALICE }),
    );
    const frame = await alice.session.encrypt({
      idempotencyKey: 'k',
      keyEpoch: 1,
      roomId: ROOM,
      selfId: ALICE,
      text: 'mine',
    });
    const reloaded = new InMemoryKeyStore();
    const identity = await alice.store.getIdentity();
    if (identity !== null) {
      await reloaded.saveIdentity(identity);
    }

    const plain = await new SenderKeySession(reloaded).decrypt(
      view(frame, { idempotencyKey: 'k', senderId: ALICE }),
      server.loaderFor(ALICE),
    );

    expect(plain).toBe('mine');
  });

  test('returns null, without throwing, when no key is available or the message was tampered', async () => {
    const server = new FakeServer();
    const alice = await member(ALICE);
    const bob = await member(BOB);
    const carol = await member(3);
    server.upload(
      ALICE,
      await alice.session.prepareEpoch({ keyEpoch: 1, members: roster(alice, bob), roomId: ROOM, selfId: ALICE }),
    );
    const frame = await alice.session.encrypt({
      idempotencyKey: 'k',
      keyEpoch: 1,
      roomId: ROOM,
      selfId: ALICE,
      text: 'x',
    });
    const message = view(frame, { idempotencyKey: 'k', senderId: ALICE });

    expect(await carol.session.decrypt(message, server.loaderFor(3))).toBeNull();
    expect(await carol.session.decrypt(message, server.loaderFor(BOB))).toBeNull();
    expect(await bob.session.decrypt({ ...message, chainIndex: 9 }, server.loaderFor(BOB))).toBeNull();
    expect(
      await bob.session.decrypt({ ...message, roomId: '019a0000-0000-7000-8000-000000000002' }, server.loaderFor(BOB)),
    ).toBeNull();
    expect(await bob.session.decrypt({ ...message, ciphertext: '%%%' }, server.loaderFor(BOB))).toBeNull();
    expect(
      await carol.session.decrypt(message, async () => {
        throw new Error('network down');
      }),
    ).toBeNull();
  });
});
