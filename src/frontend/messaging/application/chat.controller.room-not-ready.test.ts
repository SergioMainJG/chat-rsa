import { describe, expect, test } from 'bun:test';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { controllerHarness, storedMessage } from './chat.controller.test-support.ts';

// Verifier blocker B2 on S4: a room whose epoch cannot be prepared yet (a member never published an
// identity key) must hold back only its own messages, never the outbox of every other room.

const R1 = { id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' };
const R2 = { id: 'r2', keyEpoch: 1, memberIds: [1, 3], name: 'other' };

async function queuedTexts(harness: ReturnType<typeof controllerHarness>): Promise<string[]> {
  const queued = await harness.outbox.list();
  return queued.map((item) => item.text);
}

async function runTimers(harness: ReturnType<typeof controllerHarness>, rounds: number): Promise<void> {
  for (let round = 0; round < rounds && harness.timers.delays().length > 0; round += 1) {
    harness.timers.runNext();
    // Sequential on purpose: each timer round must finish before the next one fires.
    // eslint-disable-next-line no-await-in-loop
    await settle();
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
}

async function started(): Promise<ReturnType<typeof controllerHarness>> {
  const harness = controllerHarness({ rooms: [R1, R2] });
  // User 2 never opened /chat, so the server has no identity key for them.
  harness.routes['GET /api/rooms/r1/keys'] = () => Response.json([{ publicKey: 'pk1', userId: 1 }]);
  harness.routes['GET /api/rooms/r2/keys'] = () =>
    Response.json([
      { publicKey: 'pk1', userId: 1 },
      { publicKey: 'pk3', userId: 3 },
    ]);
  await harness.controller.start('r1');
  harness.connection.goOnline(['r1', 'r2']);
  await settle();
  return harness;
}

describe('a room that is not ready to encrypt', () => {
  test('does not block messages queued behind it for another room', async () => {
    const harness = await started();
    await harness.controller.send('to r1');
    await settle();
    await harness.controller.openRoom('r2');
    await harness.controller.send('to r2');
    await settle();
    // One flush retry; later timers would be the ack timeout, which this fake socket never answers.
    await runTimers(harness, 1);

    const sent = harness.connection.sends();
    expect(sent.map((frame) => frame.roomId)).toEqual(['r2']);
    const [toR2] = sent;
    harness.connection.receive({
      duplicate: false,
      idempotencyKey: toR2?.idempotencyKey ?? '',
      message: storedMessage({ id: 'm2', idempotencyKey: toR2?.idempotencyKey ?? '', keyEpoch: 1, senderId: 1 }),
      type: 'message.ack',
    });
    await settle();

    expect(await queuedTexts(harness)).toEqual(['to r1']);
    expect(harness.view.notices).toEqual([]);
  });

  test('keeps its own messages in order and sends them once the member publishes a key', async () => {
    const harness = await started();
    await harness.controller.send('first');
    await harness.controller.send('second');
    await settle();
    await runTimers(harness, 2);
    expect(harness.connection.sends()).toEqual([]);

    harness.routes['GET /api/rooms/r1/keys'] = () =>
      Response.json([
        { publicKey: 'pk1', userId: 1 },
        { publicKey: 'pk2', userId: 2 },
      ]);
    await runTimers(harness, 1);

    const [sent] = harness.connection.sends();
    expect(sent?.roomId).toBe('r1');
    const [oldest] = await harness.outbox.list();
    expect(sent?.idempotencyKey).toBe(oldest?.idempotencyKey ?? '');
    expect(await queuedTexts(harness)).toEqual(['first', 'second']);
    expect(harness.view.notices).toEqual([]);
  });
});
