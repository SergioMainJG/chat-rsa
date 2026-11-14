import { describe, expect, test } from 'bun:test';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { controllerHarness, storedMessage } from './chat.controller.test-support.ts';

// S5 (finding 4): a member whose identity key changed pauses only that room, shows the notice, and
// "Trust new key" re-pins the key and lets the paused messages go out.

const R1 = { id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' };
const R2 = { id: 'r2', keyEpoch: 1, memberIds: [1, 3], name: 'other' };
const BOB_NOTICE = 'The security key of bob changed. Messages to this room are paused until you trust the new key.';

type Harness = ReturnType<typeof controllerHarness>;

function ack(harness: Harness, index: number, id: string): void {
  const frame = harness.connection.sends()[index];
  const key = frame?.idempotencyKey ?? '';
  harness.connection.receive({
    duplicate: false,
    idempotencyKey: key,
    message: storedMessage({ id, idempotencyKey: key, roomId: frame?.roomId ?? 'r1', senderId: 1 }),
    type: 'message.ack',
  });
}

async function queuedTexts(harness: Harness): Promise<string[]> {
  const queued = await harness.outbox.list();
  return queued.map((item) => item.text);
}

async function runTimers(harness: Harness, rounds: number): Promise<void> {
  for (let round = 0; round < rounds && harness.timers.delays().length > 0; round += 1) {
    harness.timers.runNext();
    // Sequential on purpose: each timer round must finish before the next one fires.
    // eslint-disable-next-line no-await-in-loop
    await settle();
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
}

async function started(pins: Record<number, string> = {}): Promise<{ harness: Harness; prepared: string[] }> {
  const prepared: string[] = [];
  const harness = controllerHarness({
    crypto: {
      prepareEpoch: async ({ roomId }) => {
        prepared.push(roomId);
        return [];
      },
    },
    rooms: [R1, R2],
  });
  harness.routes['GET /api/rooms/r1/members'] = () =>
    Response.json([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ]);
  await Promise.all(Object.entries(pins).map(async ([userId, key]) => harness.keys.savePinnedKey(Number(userId), key)));
  await harness.controller.start('r1');
  harness.connection.goOnline(['r1', 'r2']);
  await settle();
  await settle();
  return { harness, prepared };
}

describe('identity key pinning in the chat', () => {
  test('first sight pins the other members and the message is sent', async () => {
    const { harness } = await started();

    await harness.controller.send('hello');
    await settle();

    expect(harness.connection.sends().map((frame) => frame.roomId)).toEqual(['r1']);
    expect(await harness.keys.getPinnedKey(2)).toBe('pk2');
    expect(harness.view.keyWarnings).toEqual([]);
  });

  test('the same pinned key keeps sending', async () => {
    const { harness } = await started({ 2: 'pk2' });

    await harness.controller.send('hello');
    await settle();

    expect(harness.connection.sends().map((frame) => frame.roomId)).toEqual(['r1']);
    expect(harness.view.keyWarnings).toEqual([]);
  });

  test('a changed key pauses only that room and shows the notice', async () => {
    const { harness, prepared } = await started({ 2: 'old2' });

    expect(harness.view.keyWarnings).toEqual([BOB_NOTICE]);
    await harness.controller.send('to r1');
    await settle();
    await harness.controller.openRoom('r2');
    expect(harness.view.keyWarnings).toEqual([]);
    await harness.controller.send('to r2');
    await settle();
    await runTimers(harness, 1);

    expect(prepared).not.toContain('r1');
    expect(harness.requests.filter((request) => request.includes('/rooms/r1/sender-keys'))).toEqual([]);
    expect(harness.connection.sends().map((frame) => frame.roomId)).toEqual(['r2']);
    ack(harness, 0, 'm2');
    await settle();
    expect(await queuedTexts(harness)).toEqual(['to r1']);
    expect(await harness.keys.getPinnedKey(2)).toBe('old2');
    expect(harness.view.notices).toEqual([]);

    await harness.controller.openRoom('r1');
    expect(harness.view.keyWarnings).toEqual([BOB_NOTICE]);
  });

  test('trusting the new key re-pins it, clears the notice and sends the paused message', async () => {
    const { harness, prepared } = await started({ 2: 'old2' });
    await harness.controller.send('paused');
    await settle();
    await runTimers(harness, 1);
    expect(harness.connection.sends()).toEqual([]);

    await harness.controller.trustNewKeys('r1');
    await settle();
    await settle();

    expect(await harness.keys.getPinnedKey(2)).toBe('pk2');
    expect(harness.view.keyWarnings).toEqual([]);
    expect(prepared).toContain('r1');
    const sent = harness.connection.sends();
    expect(sent.map((frame) => [frame.roomId, frame.ciphertext])).toEqual([['r1', 'paused']]);
    ack(harness, 0, 'm1');
    await settle();
    expect(await queuedTexts(harness)).toEqual([]);
  });

  test('trustNewKeys without a room trusts the open room', async () => {
    const { harness } = await started({ 2: 'old2' });

    await harness.controller.trustNewKeys();
    await settle();

    expect(await harness.keys.getPinnedKey(2)).toBe('pk2');
    expect(harness.view.keyWarnings).toEqual([]);
  });

  test('the own key is never pinned and never warns', async () => {
    const { harness } = await started({ 1: 'not my key' });

    await harness.controller.send('hello');
    await settle();

    expect(harness.view.keyWarnings).toEqual([]);
    expect(harness.connection.sends().map((frame) => frame.roomId)).toEqual(['r1']);
    expect(await harness.keys.getPinnedKey(1)).toBe('not my key');
    const fresh = await started();
    expect(await fresh.harness.keys.getPinnedKey(1)).toBeNull();
  });

  test('a member without an identity key still holds the room back without a key warning', async () => {
    const harness = controllerHarness({ rooms: [R1] });
    harness.routes['GET /api/rooms/r1/keys'] = () => Response.json([{ publicKey: 'pk1', userId: 1 }]);
    await harness.controller.start('r1');
    harness.connection.goOnline(['r1']);
    await settle();

    await harness.controller.send('waiting');
    await settle();
    await runTimers(harness, 1);

    expect(harness.connection.sends()).toEqual([]);
    expect(harness.view.keyWarnings).toEqual([]);
    expect(await queuedTexts(harness)).toEqual(['waiting']);
  });
});
