import { describe, expect, test } from 'bun:test';

import type { MessageItem } from '../presentation/chat.view-model.ts';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { controllerHarness, storedMessage } from './chat.controller.test-support.ts';

// bugs/security.bug.xml, finding 1: the server keeps idempotency keys unique per sender only, so
// another room member can reuse a key it saw in a frame or in the history. The client must never
// let one sender's message replace, or lend its plaintext to, another sender's message.

const ALICE = 2;
const BOB = 3;
const ROOM = { id: 'r1', keyEpoch: 1, memberIds: [1, ALICE, BOB], name: 'general' };

/** Without member names the view labels senders `User <id>`. */
const AS_ALICE = `User ${ALICE}`;
const AS_BOB = `User ${BOB}`;

async function openRoom(): Promise<ReturnType<typeof controllerHarness>> {
  const harness = controllerHarness({ rooms: [ROOM] });
  await harness.controller.start('r1');
  harness.connection.goOnline(['r1']);
  await settle();
  return harness;
}

function shown(messages: readonly MessageItem[]): Array<[string, string, boolean]> {
  return messages.map((item) => [item.sender, item.text, item.undecryptable]);
}

describe('a message that reuses another sender’s idempotency key', () => {
  test('is shown next to the original, which stays as its sender wrote it', async () => {
    const { connection, view } = await openRoom();

    connection.receive({
      message: storedMessage({ ciphertext: 'from-alice', id: '019a0000-0000-7000-8000-000000000001', senderId: ALICE }),
      type: 'message.new',
    });
    connection.receive({
      message: storedMessage({ ciphertext: 'from-bob', id: '019a0000-0000-7000-8000-000000000002', senderId: BOB }),
      type: 'message.new',
    });
    await settle();

    expect(shown(view.messages)).toEqual([
      [AS_ALICE, 'plain:from-alice', false],
      [AS_BOB, 'plain:from-bob', false],
    ]);
    // The page keys each message element by `key`: one shared key would draw a single row.
    expect(new Set(view.messages.map((item) => item.key)).size).toBe(2);
  });

  test('never inherits the original’s plaintext when it cannot be decrypted', async () => {
    const { connection, view } = await openRoom();

    connection.receive({
      message: storedMessage({ ciphertext: 'from-alice', id: '019a0000-0000-7000-8000-000000000001', senderId: ALICE }),
      type: 'message.new',
    });
    connection.receive({
      message: storedMessage({ ciphertext: 'bad', id: '019a0000-0000-7000-8000-000000000002', senderId: BOB }),
      type: 'message.new',
    });
    await settle();

    expect(shown(view.messages)).toEqual([
      [AS_ALICE, 'plain:from-alice', false],
      [AS_BOB, 'Unable to decrypt', true],
    ]);
  });

  test('never lends its plaintext to an undecryptable original retried when sender keys arrive', async () => {
    const { connection, routes, view } = await openRoom();
    connection.receive({
      message: storedMessage({ ciphertext: 'bad', id: '019a0000-0000-7000-8000-000000000001', senderId: ALICE }),
      type: 'message.new',
    });
    connection.receive({
      message: storedMessage({
        ciphertext: 'FORGED BY BOB',
        id: '019a0000-0000-7000-8000-000000000002',
        senderId: BOB,
      }),
      type: 'message.new',
    });
    await settle();

    routes['GET /api/rooms/r1/sender-keys?keyEpoch=1'] = () => Response.json([]);
    connection.receive({ keyEpoch: 1, roomId: 'r1', senderId: ALICE, type: 'sender-keys.available' });
    await settle();

    expect(shown(view.messages)).toEqual([
      [AS_ALICE, 'Unable to decrypt', true],
      [AS_BOB, 'plain:FORGED BY BOB', false],
    ]);
  });

  test('a message decrypted again later keeps the text it already had', async () => {
    let decryptable = true;
    const harness = controllerHarness({
      crypto: { decrypt: async (stored) => (decryptable ? `plain:${stored.ciphertext}` : null) },
      rooms: [ROOM],
    });
    await harness.controller.start('r1');
    harness.connection.goOnline(['r1']);
    await settle();
    const original = storedMessage({ ciphertext: 'from-alice', senderId: ALICE });
    harness.connection.receive({ message: original, type: 'message.new' });
    await settle();

    // The same stored message comes back (e.g. in a history page) when it no longer decrypts.
    decryptable = false;
    harness.connection.receive({ message: original, type: 'message.new' });
    await settle();

    expect(shown(harness.view.messages)).toEqual([[AS_ALICE, 'plain:from-alice', false]]);
  });

  // The server keeps (sender, key) unique, but an E2EE client does not trust the server.
  test('a different stored message under the same sender and key never inherits the first one’s text', async () => {
    const { connection, view } = await openRoom();

    connection.receive({
      message: storedMessage({ ciphertext: 'from-alice', id: '019a0000-0000-7000-8000-000000000001', senderId: ALICE }),
      type: 'message.new',
    });
    connection.receive({
      message: storedMessage({ ciphertext: 'bad', id: '019a0000-0000-7000-8000-000000000002', senderId: ALICE }),
      type: 'message.new',
    });
    await settle();

    expect(shown(view.messages)).toEqual([[AS_ALICE, 'Unable to decrypt', true]]);
  });
});
