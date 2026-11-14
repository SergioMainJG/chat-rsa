// BUG-MEDIUM-11 (S11, frontend): leaving a room must drop everything the page still keeps for it:
// queued outbox items, cached plaintext, presence and messages waiting for sender keys.
import { describe, expect, test } from 'bun:test';

import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { type ControllerHarness, controllerHarness, storedMessage } from './chat.controller.test-support.ts';
import { FLUSH_RETRY_MS } from './chat.controller.ts';

const GENERAL: RoomSummary = { id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' };
const OTHER: RoomSummary = { id: 'r2', keyEpoch: 1, memberIds: [1, 3], name: 'other' };

function harness(options: Parameters<typeof controllerHarness>[0] = {}): ControllerHarness {
  return controllerHarness({ rooms: [GENERAL, OTHER], ...options });
}

describe('ChatController.leaveRoom', () => {
  test('queued messages of the room are purged: nothing is sent and no "not sent" notice appears', async () => {
    const { connection, controller, outbox, routes, timers, view } = harness();
    await controller.start(null);
    expect(controller.activeRoomId).toBe('r1');
    await controller.send('bye');
    await controller.openRoom('r2');
    await controller.send('still here');
    await controller.openRoom('r1');

    routes['GET /api/rooms'] = () => Response.json([OTHER]);
    expect(await controller.leaveRoom()).toBeNull();
    connection.goOnline(['r2']);
    await settle();

    const queued = await outbox.list();
    expect(queued.map((item) => item.text)).toEqual(['still here']);
    expect(connection.sends().map((frame) => [frame.roomId, frame.ciphertext])).toEqual([['r2', 'still here']]);
    expect(view.notices).toEqual([]);
    expect(timers.delays()).not.toContain(FLUSH_RETRY_MS);
    expect(controller.activeRoomId).toBe('r2');
    expect(view.messages.map((item) => item.text)).toEqual(['still here']);
  });

  test('a message of the room already being encrypted when the user leaves fails silently', async () => {
    const gate: { closed: boolean; release: (() => void) | null } = { closed: false, release: null };
    const { connection, controller, outbox, routes, view } = harness({
      crypto: {
        prepareEpoch: async () => {
          if (gate.closed) {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          return [];
        },
      },
    });
    await controller.start(null);
    connection.goOnline(['r1', 'r2']);
    await settle();
    // The room rotates, so the next send has to prepare a new epoch, which hangs.
    gate.closed = true;
    routes['GET /api/rooms'] = () => Response.json([{ ...GENERAL, keyEpoch: 2 }, OTHER]);
    routes['GET /api/rooms/r1/keys'] = () =>
      Response.json([
        { publicKey: 'pk1', userId: 1 },
        { publicKey: 'pk2', userId: 2 },
      ]);
    connection.receive({ keyEpoch: 2, roomId: 'r1', type: 'room.rotated' });
    await settle();
    await controller.send('bye');
    await settle();

    routes['GET /api/rooms'] = () => Response.json([OTHER]);
    const left = controller.leaveRoom();
    gate.release?.();
    expect(await left).toBeNull();
    await settle();
    // Whatever the server answers for the stale frame, the user already left on purpose.
    for (const frame of connection.sends()) {
      connection.receive({
        code: 'forbidden',
        message: 'You are not a member of this room',
        ref: frame.idempotencyKey,
        type: 'error',
      });
    }
    await settle();

    expect(await outbox.list()).toEqual([]);
    expect(view.notices).toEqual([]);
  });

  test('presence of the left room is forgotten: rejoining shows nobody online until a new snapshot', async () => {
    const { connection, controller, routes, view } = harness();
    await controller.start(null);
    connection.goOnline(['r1', 'r2']);
    await settle();
    connection.receive({ online: [1, 2], roomId: 'r1', type: 'presence.snapshot' });
    expect(view.header?.members.map((member) => [member.id, member.online])).toEqual([
      [1, true],
      [2, true],
    ]);

    routes['GET /api/rooms'] = () => Response.json([OTHER]);
    await controller.leaveRoom();
    // Someone adds this user back: the room returns with a new epoch.
    routes['GET /api/rooms'] = () => Response.json([{ ...GENERAL, keyEpoch: 2 }, OTHER]);
    connection.receive({ keyEpoch: 2, roomId: 'r1', type: 'room.rotated' });
    await settle();
    await controller.openRoom('r1');

    expect(view.header?.id).toBe('r1');
    expect(view.header?.members.map((member) => [member.id, member.online])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  test('messages waiting for sender keys are dropped: a late sender-keys.available decrypts nothing', async () => {
    const decrypted: string[] = [];
    const { connection, controller, routes } = harness({
      crypto: {
        decrypt: async (stored) => {
          decrypted.push(stored.id);
          return null;
        },
      },
    });
    await controller.start(null);
    connection.goOnline(['r1', 'r2']);
    await settle();
    connection.receive({ message: storedMessage({ ciphertext: 'bad' }), type: 'message.new' });
    await settle();
    expect(decrypted).toEqual([storedMessage({}).id]);

    routes['GET /api/rooms'] = () => Response.json([OTHER]);
    await controller.leaveRoom();
    const before = decrypted.length;
    connection.receive({ keyEpoch: 1, roomId: 'r1', senderId: 2, type: 'sender-keys.available' });
    await settle();

    expect(decrypted.slice(before)).toEqual([]);
  });

  test('cached plaintext of the left room is dropped: after rejoining, the local store is read again', async () => {
    const { connection, controller, routes, store, view } = harness();
    await controller.start(null);
    connection.goOnline(['r1', 'r2']);
    await settle();
    // Loads (and caches) the room's local plaintext, which is empty for now.
    connection.receive({ message: storedMessage({ ciphertext: 'bad' }), type: 'message.new' });
    await settle();
    expect(view.messages.map((item) => item.text)).toEqual(['Unable to decrypt']);

    routes['GET /api/rooms'] = () => Response.json([OTHER]);
    await controller.leaveRoom();
    // Another tab decrypted a later message of the room meanwhile.
    const later = storedMessage({
      ciphertext: 'bad',
      id: '019a0000-0000-7000-8000-000000000002',
      idempotencyKey: 'k2',
    });
    await store.put({ createdAt: later.createdAt, id: later.id, roomId: 'r1', senderId: 2, text: 'seen elsewhere' });
    routes['GET /api/rooms'] = () => Response.json([{ ...GENERAL, keyEpoch: 2 }, OTHER]);
    connection.receive({ keyEpoch: 2, roomId: 'r1', type: 'room.rotated' });
    await settle();
    await controller.openRoom('r1');
    connection.receive({ message: later, type: 'message.new' });
    await settle();

    expect(view.messages.map((item) => [item.id, item.text])).toEqual([[later.id, 'seen elsewhere']]);
  });
});
