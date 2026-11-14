import { afterEach, describe, expect, test } from 'bun:test';

import {
  BOB,
  connect,
  room,
  sendFrame,
  start,
  stopHarness,
  waitUntil,
} from './messaging.socket.harness.test-support.ts';

// BUG-MEDIUM-11 (backend): settled frame tasks and the heartbeat timer must not outlive their use.

afterEach(stopHarness);

describe('in-flight frame tracking', () => {
  test('every settled frame leaves the in-flight set', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    for (let index = 0; index < 5; index += 1) {
      alice.send({ ...sendFrame(duo), chainIndex: index });
      // Sequential on purpose: each ack proves its frame task settled.
      // eslint-disable-next-line no-await-in-loop
      await alice.next('message.ack');
    }
    alice.send({ roomId: duo.id, type: 'room.subscribe' });
    await alice.next('presence.snapshot', (frame) => frame.roomId === duo.id);
    await alice.barrier();

    await waitUntil(() => harness.gateway.inFlightCount() === 0);
  });

  test('a frame still being persisted is counted until it settles', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    await waitUntil(() => harness.gateway.inFlightCount() === 0);
    harness.messages.close();

    alice.send(sendFrame(duo));
    await harness.messages.entered.promise;
    expect(harness.gateway.inFlightCount()).toBe(1);

    harness.messages.release();
    await alice.next('message.ack');
    await waitUntil(() => harness.gateway.inFlightCount() === 0);
  });
});

describe('heartbeat timer', () => {
  test('is cancelled when the last socket closes and restarted by the next one', async () => {
    const harness = start();
    await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    expect(harness.scheduler.pending()).toBeGreaterThan(0);

    alice.socket.close();
    await waitUntil(() => harness.gateway.connectionCount() === 1);
    bob.socket.close();
    await waitUntil(() => harness.gateway.connectionCount() === 0);
    // Expiry timers die with their sockets; only a leaked heartbeat would still be pending.
    expect(harness.scheduler.pending()).toBe(0);

    const again = await connect(harness, 'alice');
    expect(harness.scheduler.pending()).toBe(2);
    again.socket.close();
    await waitUntil(() => harness.gateway.connectionCount() === 0);
    expect(harness.scheduler.pending()).toBe(0);
  });
});
