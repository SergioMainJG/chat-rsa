// BUG-CRITICAL-04 (S4): a member who publishes an identity key after the epoch was prepared must
// still receive the sender's chain key. The chain key is non-extractable once created, so the
// keeper must not create it (nor mark the epoch prepared) while a room member has no identity key.
import { describe, expect, test } from 'bun:test';

import type {
  IdentityKeyView,
  MessageView,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';
import type { ApiOutcome } from './chat.api.ts';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { InMemoryKeyStore } from '../crypto/messaging.crypto.key-store.ts';
import { type SenderKeyEnvelopeUpload, SenderKeySession } from '../crypto/messaging.crypto.session.ts';
import { controllerHarness } from './chat.controller.test-support.ts';
import { EnvelopeRetryQueue, EpochKeeper } from './chat.epochs.ts';

const ROOM = 'room-1';
const EPOCH = 2;
const ALICE = 1;
const BOB = 2;

type Person = { readonly publicKey: string; readonly session: SenderKeySession; readonly store: InMemoryKeyStore };

async function person(): Promise<Person> {
  const store = new InMemoryKeyStore();
  const session = new SenderKeySession(store);
  let publicKey = '';
  await session.ensureIdentity(async (published) => {
    publicKey = published;
  });
  return { publicKey, session, store };
}

/** Plays the server side of identity keys and sender key envelopes for one room. */
class FakeKeyServer {
  readonly envelopes: SenderKeyEnvelopeView[] = [];
  readonly identities: IdentityKeyView[] = [];

  keeperFor(selfId: number, session: SenderKeySession): EpochKeeper {
    return new EpochKeeper({
      api: {
        roomKeys: async (): Promise<ApiOutcome<IdentityKeyView[]>> => ({ kind: 'ok', value: [...this.identities] }),
        uploadSenderKeys: async (_roomId, _keyEpoch, uploads: readonly SenderKeyEnvelopeUpload[]) => {
          for (const upload of uploads) {
            this.envelopes.push({ ...upload, senderId: selfId });
          }
          return { kind: 'ok', value: null };
        },
      },
      crypto: session,
      queue: new EnvelopeRetryQueue(),
      selfId,
    });
  }

  loaderFor(recipientId: number) {
    return async (roomId: string, keyEpoch: number, senderId: number): Promise<null | SenderKeyEnvelopeView> =>
      this.envelopes.find(
        (envelope) =>
          envelope.roomId === roomId &&
          envelope.keyEpoch === keyEpoch &&
          envelope.senderId === senderId &&
          envelope.recipientId === recipientId,
      ) ?? null;
  }

  publishIdentity(userId: number, publicKey: string): void {
    this.identities.push({ publicKey, userId });
  }

  recipientsOf(senderId: number): number[] {
    return this.envelopes.filter((envelope) => envelope.senderId === senderId).map((envelope) => envelope.recipientId);
  }
}

async function aliceSends(alice: Person, text: string): Promise<MessageView> {
  const fields = await alice.session.encrypt({
    idempotencyKey: 'key-1',
    keyEpoch: EPOCH,
    roomId: ROOM,
    selfId: ALICE,
    text,
  });
  return {
    ...fields,
    createdAt: '2026-11-12T10:00:00.000Z',
    id: '019a0000-0000-7000-8000-000000000001',
    idempotencyKey: 'key-1',
    roomId: ROOM,
    senderId: ALICE,
  };
}

describe('EpochKeeper with a member who publishes an identity key late', () => {
  test('the epoch is not prepared while a member has no identity key: no chain key, no upload', async () => {
    const alice = await person();
    const server = new FakeKeyServer();
    server.publishIdentity(ALICE, alice.publicKey);
    const keeper = server.keeperFor(ALICE, alice.session);

    expect(await keeper.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(false);

    expect(server.envelopes).toEqual([]);
    expect(await alice.store.getChainKey({ keyEpoch: EPOCH, roomId: ROOM, senderId: ALICE })).toBeNull();
    // Sending waits: there is no chain key to encrypt with yet.
    const refused = await aliceSends(alice, 'Hello Bob!').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain('call prepareEpoch first');
  });

  test('once the member publishes, the next ensureEpoch wraps the chain key for every member and Bob decrypts', async () => {
    const alice = await person();
    const bob = await person();
    const server = new FakeKeyServer();
    server.publishIdentity(ALICE, alice.publicKey);
    const keeper = server.keeperFor(ALICE, alice.session);
    expect(await keeper.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(false);

    server.publishIdentity(BOB, bob.publicKey);

    expect(await keeper.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(true);
    expect(server.recipientsOf(ALICE).toSorted((left, right) => left - right)).toEqual([ALICE, BOB]);
    const sent = await aliceSends(alice, 'Hello Bob!');
    expect(await bob.session.decrypt(sent, server.loaderFor(BOB))).toBe('Hello Bob!');
    // Alice's other tabs and reloads unwrap her own envelope.
    const aliceReloaded = new SenderKeySession(alice.store);
    expect(await aliceReloaded.decrypt(sent, server.loaderFor(ALICE))).toBe('Hello Bob!');
  });

  test('a reload (new keeper, same key store) after Bob publishes still reaches Bob', async () => {
    const alice = await person();
    const bob = await person();
    const server = new FakeKeyServer();
    server.publishIdentity(ALICE, alice.publicKey);
    expect(await server.keeperFor(ALICE, alice.session).ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(false);

    server.publishIdentity(BOB, bob.publicKey);
    const reloaded = server.keeperFor(ALICE, new SenderKeySession(alice.store));

    expect(await reloaded.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(true);
    const sent = await aliceSends(alice, 'Hello Bob!');
    expect(await bob.session.decrypt(sent, server.loaderFor(BOB))).toBe('Hello Bob!');
  });

  test('when every member already has a key the epoch is prepared at once, exactly once', async () => {
    const alice = await person();
    const bob = await person();
    const server = new FakeKeyServer();
    server.publishIdentity(ALICE, alice.publicKey);
    server.publishIdentity(BOB, bob.publicKey);
    const keeper = server.keeperFor(ALICE, alice.session);

    expect(await keeper.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(true);
    expect(await keeper.ensureEpoch(ROOM, EPOCH, [ALICE, BOB])).toBe(true);

    expect(server.recipientsOf(ALICE).toSorted((left, right) => left - right)).toEqual([ALICE, BOB]);
  });
});

describe('ChatController with a member who publishes an identity key late', () => {
  test('a message waits in the outbox until every member has a key, then goes out with an envelope for each', async () => {
    const uploads: unknown[] = [];
    const harness = controllerHarness({
      crypto: {
        prepareEpoch: async ({ keyEpoch, members, roomId }) =>
          members.map(({ userId }) => ({
            authTag: 't',
            ciphertext: 'c',
            ephemeralPublicKey: 'e',
            iv: 'i',
            keyEpoch,
            recipientId: userId,
            roomId,
          })),
      },
    });
    const { connection, controller, outbox, routes, timers, view } = harness;
    routes['GET /api/rooms/r1/keys'] = () => Response.json([{ publicKey: 'pk1', userId: 1 }]);
    routes['POST /api/rooms/r1/sender-keys'] = (body) => {
      uploads.push(body);
      return new Response(null, { status: 201 });
    };
    await controller.start(null);
    await controller.send('Hello Bob!');
    connection.goOnline();
    await settle();

    expect(connection.sends()).toEqual([]);
    expect(uploads).toEqual([]);
    const queued = await outbox.list();
    expect(queued.map((item) => item.text)).toEqual(['Hello Bob!']);
    expect(view.messages.map((item) => [item.text, item.status])).toEqual([['Hello Bob!', 'pending']]);
    expect(view.notices).toEqual([]);

    // Bob opens /chat and publishes his identity key; the outbox retries on its timer.
    routes['GET /api/rooms/r1/keys'] = () =>
      Response.json([
        { publicKey: 'pk1', userId: 1 },
        { publicKey: 'pk2', userId: 2 },
      ]);
    timers.runNext();
    await settle();

    expect(uploads).toEqual([
      {
        envelopes: [1, 2].map((recipientId) => ({
          authTag: 't',
          ciphertext: 'c',
          ephemeralPublicKey: 'e',
          iv: 'i',
          recipientId,
        })),
        keyEpoch: 1,
      },
    ]);
    expect(connection.sends().map((frame) => frame.ciphertext)).toEqual(['Hello Bob!']);
    expect(view.notices).toEqual([]);
  });
});
