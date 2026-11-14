import { describe, expect, test } from 'bun:test';

import type { IdentityKeyView, SenderKeyEnvelopeView } from '../../../shared/contracts/messaging.contract.ts';
import type { SenderKeyEnvelopeUpload } from '../crypto/messaging.crypto.session.ts';
import type { ApiOutcome } from './chat.api.ts';

import { EnvelopeCache, EnvelopeRetryQueue, EpochKeeper } from './chat.epochs.ts';

const SELF = 1;
const KEYS: IdentityKeyView[] = [
  { publicKey: 'pk1', userId: 1 },
  { publicKey: 'pk2', userId: 2 },
];

function envelope(recipientId: number, keyEpoch = 1): SenderKeyEnvelopeUpload {
  return { authTag: 't', ciphertext: 'c', ephemeralPublicKey: 'e', iv: 'i', keyEpoch, recipientId, roomId: 'r' };
}

const OK_NULL: ApiOutcome<null> = { kind: 'ok', value: null };
const FAILED: ApiOutcome<null> = { kind: 'failure', message: 'down', status: 503 };

/** Mimics SenderKeySession.prepareEpoch: envelopes the first time per epoch, [] afterwards. */
function fakeCrypto(): {
  calls: unknown[];
  prepareEpoch: (input: {
    keyEpoch: number;
    members: readonly unknown[];
    roomId: string;
  }) => Promise<SenderKeyEnvelopeUpload[]>;
  trustIdentityKeys: () => Promise<void>;
  verifyIdentityKeys: () => Promise<number[]>;
} {
  const prepared = new Set<string>();
  const calls: unknown[] = [];
  return {
    calls,
    prepareEpoch: async (input) => {
      calls.push(input);
      const key = `${input.roomId}:${input.keyEpoch}`;
      if (prepared.has(key)) {
        return [];
      }
      prepared.add(key);
      return [envelope(1, input.keyEpoch), envelope(2, input.keyEpoch)];
    },
    // Pinning has its own tests (chat.epochs.key-pinning.test.ts): every key passes here.
    trustIdentityKeys: async () => {
      // Nothing is pinned by this double.
    },
    verifyIdentityKeys: async () => [],
  };
}

function setup(uploads: Array<ApiOutcome<null>>): {
  crypto: ReturnType<typeof fakeCrypto>;
  keeper: EpochKeeper;
  queue: EnvelopeRetryQueue;
  uploaded: Array<{ envelopes: readonly SenderKeyEnvelopeUpload[]; keyEpoch: number; roomId: string }>;
} {
  const uploaded: Array<{ envelopes: readonly SenderKeyEnvelopeUpload[]; keyEpoch: number; roomId: string }> = [];
  const crypto = fakeCrypto();
  const queue = new EnvelopeRetryQueue();
  const keeper = new EpochKeeper({
    api: {
      roomKeys: async () => ({ kind: 'ok', value: KEYS }),
      uploadSenderKeys: async (roomId, keyEpoch, envelopes) => {
        uploaded.push({ envelopes, keyEpoch, roomId });
        return uploads.shift() ?? OK_NULL;
      },
    },
    crypto,
    queue,
    selfId: SELF,
  });
  return { crypto, keeper, queue, uploaded };
}

describe('EpochKeeper', () => {
  test('prepares the epoch for every member with a published key and uploads the envelopes', async () => {
    const { crypto, keeper, queue, uploaded } = setup([]);

    expect(await keeper.ensureEpoch('r', 1)).toBe(true);

    expect(crypto.calls).toEqual([
      {
        keyEpoch: 1,
        members: [
          { publicKeyBase64: 'pk1', userId: 1 },
          { publicKeyBase64: 'pk2', userId: 2 },
        ],
        roomId: 'r',
        selfId: SELF,
      },
    ]);
    expect(uploaded).toEqual([{ envelopes: [envelope(1), envelope(2)], keyEpoch: 1, roomId: 'r' }]);
    expect(queue.size).toBe(0);
  });

  test('a prepared epoch is not prepared again', async () => {
    const { crypto, keeper } = setup([]);
    await keeper.ensureEpoch('r', 1);
    await keeper.ensureEpoch('r', 1);

    expect(crypto.calls).toHaveLength(1);
  });

  test('a failed upload keeps the batch, which is retried before the next send and cleared after success', async () => {
    const { keeper, queue, uploaded } = setup([FAILED]);

    expect(await keeper.ensureEpoch('r', 1)).toBe(false);
    expect(queue.size).toBe(1);

    // prepareEpoch now returns [] for this epoch: only the stored batch can reach the server.
    expect(await keeper.ensureEpoch('r', 1)).toBe(true);
    expect(uploaded).toHaveLength(2);
    expect(uploaded[1]).toEqual(uploaded[0]);
    expect(queue.size).toBe(0);
  });

  test('while the stored batch keeps failing the epoch is not ready', async () => {
    const { keeper, queue } = setup([FAILED, FAILED]);
    await keeper.ensureEpoch('r', 1);

    expect(await keeper.ensureEpoch('r', 1)).toBe(false);
    expect(queue.size).toBe(1);
  });

  test('retryPending uploads every stored batch', async () => {
    const { keeper, queue, uploaded } = setup([FAILED, FAILED, FAILED]);
    await keeper.ensureEpoch('r', 1);
    await keeper.ensureEpoch('r', 2);
    expect(queue.size).toBe(2);

    expect(await keeper.retryPending()).toBe(true);
    expect(queue.size).toBe(0);
    expect(uploaded.slice(3).map((upload) => upload.keyEpoch)).toEqual([1, 2]);
  });

  test('a failed key lookup prepares nothing and reports the epoch as not ready', async () => {
    const crypto = fakeCrypto();
    const keeper = new EpochKeeper({
      api: {
        roomKeys: async () => ({ kind: 'failure', message: 'down', status: 503 }),
        uploadSenderKeys: async () => OK_NULL,
      },
      crypto,
      queue: new EnvelopeRetryQueue(),
      selfId: SELF,
    });

    expect(await keeper.ensureEpoch('r', 1)).toBe(false);
    expect(crypto.calls).toEqual([]);
  });

  test('forget makes the next ensureEpoch prepare again', async () => {
    const { crypto, keeper } = setup([]);
    await keeper.ensureEpoch('r', 1);
    keeper.forget('r', 1);
    await keeper.ensureEpoch('r', 1);

    expect(crypto.calls).toHaveLength(2);
  });
});

function view(senderId: number): SenderKeyEnvelopeView {
  return { ...envelope(SELF), senderId };
}

describe('EnvelopeCache', () => {
  test('fetches the envelopes of an epoch once and picks the sender', async () => {
    const fetched: Array<[string, number]> = [];
    const cache = new EnvelopeCache(async (roomId, keyEpoch) => {
      fetched.push([roomId, keyEpoch]);
      return { kind: 'ok', value: [view(2), view(3)] };
    });

    expect(await cache.load('r', 1, 3)).toEqual(view(3));
    expect(await cache.load('r', 1, 2)).toEqual(view(2));
    expect(await cache.load('r', 1, 9)).toBeNull();
    expect(fetched).toEqual([['r', 1]]);
  });

  test('invalidate refetches the epoch, for sender-keys.available', async () => {
    let envelopes = [view(2)];
    const cache = new EnvelopeCache(async () => ({ kind: 'ok', value: envelopes }));
    expect(await cache.load('r', 1, 3)).toBeNull();

    envelopes = [view(2), view(3)];
    cache.invalidate('r', 1);
    expect(await cache.load('r', 1, 3)).toEqual(view(3));
  });

  test('a failed fetch is not cached', async () => {
    let calls = 0;
    const cache = new EnvelopeCache(async () => {
      calls += 1;
      return calls === 1 ? { kind: 'failure', message: 'down', status: 503 } : { kind: 'ok', value: [view(2)] };
    });

    expect(await cache.load('r', 1, 2)).toBeNull();
    expect(await cache.load('r', 1, 2)).toEqual(view(2));
  });
});
