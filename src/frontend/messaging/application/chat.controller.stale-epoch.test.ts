// BUG-HIGH-05 (S5): a stale key epoch after a reconnect, a reused idempotency key, or chain index
// drift between tabs must never leave the outbox retrying the same refused frame forever.
import { describe, expect, test } from 'bun:test';

import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { conflict, type ControllerHarness, controllerHarness, storedMessage } from './chat.controller.test-support.ts';
import { FLUSH_RETRY_MS } from './chat.controller.ts';

const STALE = 'Sender key epoch is stale; rotate to epoch 3';
const REUSED = 'idempotencyKey was already used for another message';
const CHAIN_USED = 'chainIndex was already used in this key epoch; encrypt again';

function ack(harness: ControllerHarness, idempotencyKey: string, id: string): void {
  harness.connection.receive({
    duplicate: false,
    idempotencyKey,
    message: storedMessage({ id, idempotencyKey, keyEpoch: 3, senderId: 1 }),
    type: 'message.ack',
  });
}

function room(keyEpoch: number): RoomSummary {
  return { id: 'r1', keyEpoch, memberIds: [1, 2], name: 'general' };
}

function serveRooms(harness: ControllerHarness, ...rooms: RoomSummary[]): void {
  const { routes } = harness;
  routes['GET /api/rooms'] = () => Response.json(rooms);
}

/** Fires every pending flush retry timer (bounded), settling after each; returns how many fired. */
async function drainRetries(harness: ControllerHarness, limit = 20): Promise<number> {
  let fired = 0;
  while (harness.timers.delays().includes(FLUSH_RETRY_MS) && fired < limit) {
    harness.timers.runNext();
    fired += 1;
    // eslint-disable-next-line no-await-in-loop -- each retry must settle before the next fires
    await settle();
  }
  return fired;
}

describe('ChatController after a missed room.rotated (Attack B)', () => {
  test('ready reloads the rooms even when every room id is already known', async () => {
    const harness = controllerHarness({ rooms: [room(2)] });
    await harness.controller.start(null);
    serveRooms(harness, room(3));
    const before = harness.requests.filter((request) => request === 'GET /api/rooms').length;

    harness.connection.goOnline(['r1']);
    await settle();

    expect(harness.requests.filter((request) => request === 'GET /api/rooms')).toHaveLength(before + 1);
    // A message queued after the reconnect is encrypted for the fresh epoch.
    await harness.controller.send('hi');
    await settle();
    expect(harness.connection.sends().map((frame) => frame.keyEpoch)).toEqual([3]);
  });

  test('a stale-epoch conflict refreshes the room before the retry, which goes out with the new epoch', async () => {
    const harness = controllerHarness({ rooms: [room(2)] });
    const { connection, controller, outbox, view } = harness;
    await controller.start(null);
    connection.goOnline(['r1']);
    await settle();
    await controller.send('hi');
    await settle();
    expect(connection.sends().map((frame) => frame.keyEpoch)).toEqual([2]);

    // The room rotated on the server and this client missed the frame.
    serveRooms(harness, room(3));
    connection.receive(conflict('key-1', STALE));
    await settle();

    expect(connection.sends().map((frame) => [frame.idempotencyKey, frame.keyEpoch])).toEqual([
      ['key-1', 2],
      ['key-1', 3],
    ]);
    ack(harness, 'key-1', '019a0000-0000-7000-8000-0000000000a1');
    await settle();
    expect(await outbox.list()).toEqual([]);
    expect(view.messages.map((item) => item.status)).toEqual(['delivered']);
    expect(view.notices).toEqual([]);
    expect(harness.timers.delays()).not.toContain(FLUSH_RETRY_MS);
  });

  test('a server that keeps answering conflict ends in a permanent failure, not a retry every 5 s forever', async () => {
    const harness = controllerHarness({ rooms: [room(2)] });
    const { connection, controller, outbox, view } = harness;
    await controller.start(null);
    connection.goOnline(['r1']);
    await settle();
    await controller.send('hi');
    await settle();
    const answered = new Set<number>();
    const refuseAll = (): void => {
      for (const [index] of connection.sends().entries()) {
        if (!answered.has(index)) {
          answered.add(index);
          connection.receive(conflict('key-1', STALE));
        }
      }
    };

    let fired = 0;
    for (let round = 0; round < 20; round += 1) {
      refuseAll();
      // eslint-disable-next-line no-await-in-loop -- each refusal must settle before the next
      await settle();
      refuseAll();
      // eslint-disable-next-line no-await-in-loop -- see above
      await settle();
      // eslint-disable-next-line no-await-in-loop -- see above
      const ran = await drainRetries(harness, 1);
      fired += ran;
      if (ran === 0) {
        break;
      }
    }

    expect(fired).toBeLessThan(20);
    expect(harness.timers.delays()).not.toContain(FLUSH_RETRY_MS);
    expect(await outbox.list()).toEqual([]);
    expect(view.messages.map((item) => item.failed)).toEqual([true]);
    expect(view.notices).toEqual([`A message was not sent: ${STALE}`]);
  });
});

describe('ChatController with a reused idempotency key', () => {
  test('"idempotencyKey was already used for another message" is a permanent rejection', async () => {
    const harness = controllerHarness();
    const { connection, controller, outbox, view } = harness;
    await controller.start(null);
    connection.goOnline(['r1']);
    await settle();
    await controller.send('first');
    await controller.send('second');
    await settle();

    connection.receive(conflict('key-1', REUSED));
    await settle();
    connection.receive(conflict('key-1', REUSED));
    await settle();

    expect(harness.timers.delays()).not.toContain(FLUSH_RETRY_MS);
    const queued = await outbox.list();
    expect(queued.map((item) => item.idempotencyKey)).toEqual(['key-2']);
    expect(view.notices).toEqual([`A message was not sent: ${REUSED}`]);
    expect(view.messages.map((item) => [item.text, item.failed])).toEqual([
      ['first', true],
      ['second', false],
    ]);
    // The rest of the outbox is not blocked behind it.
    expect(connection.sends().at(-1)?.idempotencyKey).toBe('key-2');
  });
});

describe('ChatController with chain index drift between tabs (Attack A)', () => {
  test('conflicts on used chain indexes advance the index until one is free, then the outbox drains', async () => {
    let nextIndex = 0;
    const harness = controllerHarness({
      crypto: {
        encrypt: async ({ keyEpoch, text }) => {
          const chainIndex = nextIndex;
          nextIndex += 1;
          return { authTag: 't', chainIndex, ciphertext: text, iv: 'i', keyEpoch };
        },
      },
    });
    const { connection, controller, outbox, view } = harness;
    await controller.start(null);
    connection.goOnline(['r1']);
    await settle();
    await controller.send('from tab 2');
    await settle();

    // Another tab already used chain indexes 0 and 1 in this epoch.
    connection.receive(conflict('key-1', CHAIN_USED));
    await settle();
    connection.receive(conflict('key-1', CHAIN_USED));
    await settle();
    expect(await drainRetries(harness, 1)).toBe(1);

    expect(connection.sends().map((frame) => frame.chainIndex)).toEqual([0, 1, 2]);
    ack(harness, 'key-1', '019a0000-0000-7000-8000-0000000000a2');
    await settle();
    expect(await outbox.list()).toEqual([]);
    expect(view.messages.map((item) => item.status)).toEqual(['delivered']);
    expect(view.notices).toEqual([]);
    expect(harness.timers.delays()).not.toContain(FLUSH_RETRY_MS);
  });
});
