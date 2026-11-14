import { afterEach, describe, expect, test } from 'bun:test';

import {
  BEARER_PREFIX,
  CloseCode,
  SOCKET_PATH,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import { AddMemberUseCase, LeaveRoomUseCase } from '../application/messaging.rooms.use-case.ts';
import {
  ALICE,
  BOB,
  CAROL,
  closeCode,
  connect,
  HOUR,
  MALLORY,
  room,
  sendFrame,
  START,
  start,
  stopHarness,
  upgradeRequest,
  waitUntil,
} from './messaging.socket.harness.test-support.ts';

const RETRIED_KEY = crypto.randomUUID();
const STALE_KEY = crypto.randomUUID();
const ALICE_FIRST_KEY = crypto.randomUUID();
const MALLORY_KEY = crypto.randomUUID();
const ALICE_SECOND_KEY = crypto.randomUUID();
const IN_FLIGHT_KEY = crypto.randomUUID();

afterEach(stopHarness);

describe('upgrade authentication', () => {
  test.each([
    ['no protocol header', null],
    ['no bearer entry', SOCKET_PROTOCOL],
    ['no chat-rsa.v1 entry', `${BEARER_PREFIX}alice`],
    ['two bearer entries', `${SOCKET_PROTOCOL}, ${BEARER_PREFIX}alice, ${BEARER_PREFIX}bob`],
    ['an empty token', `${SOCKET_PROTOCOL}, ${BEARER_PREFIX}`],
    ['an invalid token', `${SOCKET_PROTOCOL}, ${BEARER_PREFIX}forged`],
  ])('rejects %s with a 401 JSON body', async (_case, protocol) => {
    const harness = start();
    const response = await harness.gateway.upgrade(upgradeRequest(harness, protocol), harness.server);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ path: SOCKET_PATH, statusCode: 401 });
    expect(harness.gateway.connectionCount()).toBe(0);
  });

  test('answers with chat-rsa.v1 only and never echoes the token', async () => {
    const harness = start();
    const alice = await connect(harness, 'alice');
    expect(alice.socket.protocol).toBe(SOCKET_PROTOCOL);
    expect(alice.socket.protocol).not.toContain('alice');
  });

  test('sends a ready frame with the user, their rooms and the token expiry', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    expect(alice.frames[0]).toEqual({
      expiresAt: new Date(START + HOUR).toISOString(),
      roomIds: [duo.id],
      type: 'ready',
      userId: ALICE,
    });
  });
});

describe('message.send', () => {
  test('acks only after persistence; the other member gets message.new and the sender does not', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    harness.messages.close();
    alice.send(sendFrame(duo, RETRIED_KEY));
    await harness.messages.entered.promise;
    await alice.barrier();
    expect(alice.count('message.ack')).toBe(0);

    harness.messages.release();
    const ack = await alice.next('message.ack');
    expect(harness.messages.messages.map((message): string => message.id)).toEqual([ack.message.id]);
    expect(ack).toMatchObject({ duplicate: false, idempotencyKey: RETRIED_KEY, message: { roomId: duo.id } });
    const delivered = await bob.next('message.new');
    expect(delivered.message).toEqual(ack.message);
    await alice.barrier();
    expect(alice.count('message.new')).toBe(0);
  });

  test('a duplicate send is acked with duplicate: true and is not published again', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    alice.send(sendFrame(duo, RETRIED_KEY));
    const first = await alice.next('message.ack');
    alice.send(sendFrame(duo, RETRIED_KEY));
    const second = await alice.next('message.ack');
    expect(second).toMatchObject({ duplicate: true, idempotencyKey: RETRIED_KEY });
    expect(second.message.id).toBe(first.message.id);
    await bob.barrier();
    expect(bob.count('message.new')).toBe(1);
  });

  test('a stale key epoch is answered with a conflict error that refers to the idempotency key', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    alice.send(sendFrame({ id: duo.id, keyEpoch: duo.keyEpoch + 5 }, STALE_KEY));
    expect(await alice.next('error')).toMatchObject({ code: 'conflict', ref: STALE_KEY });
    expect(harness.messages.messages).toHaveLength(0);
  });
});

describe('room authorization', () => {
  test('a non-member gets forbidden for send, receipt, typing and subscribe, and receives nothing', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const mallory = await connect(harness, 'mallory');
    alice.send(sendFrame(duo, ALICE_FIRST_KEY));
    const ack = await alice.next('message.ack');

    mallory.send(sendFrame(duo, MALLORY_KEY));
    expect(await mallory.next('error')).toMatchObject({ code: 'forbidden', ref: MALLORY_KEY });
    mallory.send({ kind: 'read', messageId: ack.message.id, roomId: duo.id, type: 'receipt' });
    expect(await mallory.next('error')).toMatchObject({ code: 'forbidden', ref: duo.id });
    mallory.send({ active: true, roomId: duo.id, type: 'typing' });
    expect(await mallory.next('error')).toMatchObject({ code: 'forbidden', ref: duo.id });
    mallory.send({ roomId: duo.id, type: 'room.subscribe' });
    expect(await mallory.next('error')).toMatchObject({ code: 'forbidden', ref: duo.id });

    alice.send(sendFrame(duo, ALICE_SECOND_KEY));
    await alice.next('message.ack');
    alice.send({ active: true, roomId: duo.id, type: 'typing' });
    await alice.barrier();
    await mallory.barrier();
    expect(harness.messages.messages).toHaveLength(2);
    expect(mallory.frames.filter((frame) => frame.type !== 'error' && frame.type !== 'ready')).toEqual([]);
  });

  test('a member removed through membersChanged stops receiving; an added member starts', async () => {
    const harness = start();
    const trio = await room(harness, [BOB, CAROL]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    const carol = await connect(harness, 'carol');
    const mallory = await connect(harness, 'mallory');

    const left = await new LeaveRoomUseCase(harness.rooms).execute(CAROL, trio.id);
    const added = await new AddMemberUseCase(harness.rooms).execute(ALICE, trio.id, { userId: MALLORY });
    if (!left.ok || !added.ok) {
      throw new Error('membership change failed');
    }
    harness.gateway.events.membersChanged(left.value, { added: null, removed: CAROL });
    harness.gateway.events.membersChanged(added.value, { added: MALLORY, removed: null });
    expect(await bob.next('room.rotated', (frame) => frame.keyEpoch === added.value.keyEpoch)).toEqual({
      keyEpoch: added.value.keyEpoch,
      roomId: trio.id,
      type: 'room.rotated',
    });
    await mallory.next('room.rotated');

    alice.send(sendFrame({ id: trio.id, keyEpoch: added.value.keyEpoch }));
    await bob.next('message.new');
    await mallory.next('message.new');
    await carol.barrier();
    expect(carol.count('message.new')).toBe(0);
    expect(carol.count('room.rotated')).toBe(0);
  });

  test('sender-keys.available is published to the room', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    harness.gateway.events.senderKeysAvailable(duo.id, duo.keyEpoch, ALICE);
    expect(await bob.next('sender-keys.available')).toEqual({
      keyEpoch: duo.keyEpoch,
      roomId: duo.id,
      senderId: ALICE,
      type: 'sender-keys.available',
    });
  });

  test('room.subscribe by a member subscribes and answers with a presence snapshot', async () => {
    const harness = start();
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    const duo = await room(harness, [BOB]);
    bob.send({ roomId: duo.id, type: 'room.subscribe' });
    expect(await bob.next('presence.snapshot')).toEqual({
      online: [ALICE, BOB],
      roomId: duo.id,
      type: 'presence.snapshot',
    });
    alice.send({ active: true, roomId: duo.id, type: 'typing' });
    expect(await bob.next('typing')).toEqual({ active: true, roomId: duo.id, type: 'typing', userId: ALICE });
    await alice.barrier();
    expect(alice.count('typing')).toBe(0);
  });
});

describe('receipts and presence', () => {
  test('a receipt is published to the room', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    alice.send(sendFrame(duo));
    const { message } = await bob.next('message.new');
    bob.send({ kind: 'read', messageId: message.id, roomId: duo.id, type: 'receipt' });
    expect(await alice.next('receipt')).toEqual({
      delivered: message.id,
      read: message.id,
      roomId: duo.id,
      type: 'receipt',
      userId: BOB,
    });
  });

  test('a user stays online until their last socket closes', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const bob = await connect(harness, 'bob');
    const first = await connect(harness, 'alice');
    expect(await bob.next('presence')).toEqual({ online: true, roomId: duo.id, type: 'presence', userId: ALICE });
    expect(await first.next('presence.snapshot')).toEqual({
      online: [ALICE, BOB],
      roomId: duo.id,
      type: 'presence.snapshot',
    });
    const second = await connect(harness, 'alice');

    first.socket.close();
    await waitUntil(() => harness.gateway.connectionCount() === 2);
    await bob.barrier();
    expect(bob.count('presence')).toBe(1);

    second.socket.close();
    expect(await bob.next('presence')).toEqual({ online: false, roomId: duo.id, type: 'presence', userId: ALICE });
  });
});

describe('token refresh and expiry', () => {
  test('a refresh with a valid token of the same user keeps the socket open and moves the expiry', async () => {
    const harness = start();
    const alice = await connect(harness, 'alice-short');
    alice.send({ token: 'alice-later', type: 'auth.refresh' });
    expect(await alice.next('auth.refreshed')).toEqual({
      expiresAt: new Date(START + 20_000).toISOString(),
      type: 'auth.refreshed',
    });
    harness.scheduler.advance(10_000);
    await alice.barrier();
    expect(alice.socket.readyState).toBe(WebSocket.OPEN);

    harness.scheduler.advance(10_000);
    expect(await alice.next('error')).toMatchObject({ code: 'auth_failed' });
    expect(await closeCode(alice)).toBe(CloseCode.AuthFailed);
  });

  test.each([
    ['another user', 'bob'],
    ['another session of the same user', 'alice-phone'],
    ['an invalid token', 'forged'],
  ])('a refresh with %s sends auth_failed and closes with 4001', async (_case, token) => {
    const harness = start();
    const alice = await connect(harness, 'alice');
    alice.send({ token, type: 'auth.refresh' });
    expect(await alice.next('error')).toMatchObject({ code: 'auth_failed', ref: null, type: 'error' });
    const closed = await alice.closed;
    expect(closed.code).toBe(CloseCode.AuthFailed);
    expect(closed.reason.length).toBeGreaterThan(0);
    expect(harness.gateway.connectionCount()).toBe(0);
  });

  test('closing a session closes its sockets with 4001 and leaves other sessions open', async () => {
    const harness = start();
    const laptop = await connect(harness, 'alice');
    const phone = await connect(harness, 'alice-phone');
    const bob = await connect(harness, 'bob');

    harness.gateway.closeSession('s1');

    expect(await laptop.next('error')).toMatchObject({ code: 'auth_failed' });
    expect(await closeCode(laptop)).toBe(CloseCode.AuthFailed);
    await phone.barrier();
    await bob.barrier();
    expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    expect(bob.socket.readyState).toBe(WebSocket.OPEN);
    expect(harness.gateway.connectionCount()).toBe(2);
  });

  test('the expiry timer closes the socket with 4001', async () => {
    const harness = start();
    const alice = await connect(harness, 'alice-short');
    harness.scheduler.advance(9999);
    await alice.barrier();
    harness.scheduler.advance(1);
    expect(await alice.next('error')).toMatchObject({ code: 'auth_failed' });
    expect(await closeCode(alice)).toBe(CloseCode.AuthFailed);
  });
});

describe('heartbeat', () => {
  test('a socket that answers pings stays open', async () => {
    const harness = start();
    const alice = await connect(harness, 'alice');
    harness.scheduler.advance(30_000);
    await waitUntil(() => harness.pongs.count === 1);
    harness.scheduler.advance(30_000);
    await alice.barrier();
    expect(alice.socket.readyState).toBe(WebSocket.OPEN);
  });

  test('a socket with no pong for the timeout is closed with 4008 and its presence and timers freed', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const bob = await connect(harness, 'bob');
    const alice = await connect(harness, 'alice');
    await bob.next('presence', (frame) => frame.online);
    harness.muted.add(ALICE);
    harness.scheduler.advance(30_000);
    await waitUntil(() => harness.pongs.count === 1);
    harness.scheduler.advance(30_000);
    expect(await closeCode(alice)).toBe(CloseCode.HeartbeatTimeout);
    expect(await bob.next('presence', (frame) => !frame.online)).toEqual({
      online: false,
      roomId: duo.id,
      type: 'presence',
      userId: ALICE,
    });
    expect(harness.gateway.connectionCount()).toBe(1);
    // Left: the heartbeat interval and Bob's expiry timer. Alice's expiry timer was cancelled.
    expect(harness.scheduler.pending()).toBe(2);
    expect(bob.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('frame validation and limits', () => {
  test.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[1]'],
    ['an unknown type', JSON.stringify({ type: 'message.delete' })],
    ['an unknown field', JSON.stringify({ roomId: 'x', type: 'room.subscribe', x: 1 })],
    ['a binary frame', new Uint8Array([1, 2, 3])],
  ])('%s gets a bad_frame error and the socket stays open', async (_case, raw) => {
    const harness = start();
    const alice = await connect(harness, 'alice');
    alice.socket.send(raw);
    expect(await alice.next('error')).toMatchObject({ code: 'bad_frame', ref: null });
    alice.send({ token: 'alice', type: 'auth.refresh' });
    await alice.next('auth.refreshed');
  });

  test('repeated bad frames close the socket with 1008', async () => {
    const harness = start({ capacity: 30, refillPerSecond: 10 });
    const alice = await connect(harness, 'alice');
    for (let index = 0; index < 3; index += 1) {
      alice.socket.send('not json');
    }
    expect(await closeCode(alice)).toBe(CloseCode.PolicyViolation);
    expect(alice.count('error', (frame) => frame.code === 'bad_frame')).toBe(2);
  });

  test('a flood of valid frames closes the socket with 1008', async () => {
    const harness = start({ capacity: 3, refillPerSecond: 1 });
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    for (let index = 0; index < 4; index += 1) {
      alice.send({ active: true, roomId: duo.id, type: 'typing' });
    }
    expect(await closeCode(alice)).toBe(CloseCode.PolicyViolation);
    expect(alice.count('error', (frame) => frame.code === 'rate_limited')).toBe(1);
  });
});

describe('drain', () => {
  test('waits for an in-flight send to persist, then closes every socket with 1001 and rejects upgrades', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const bob = await connect(harness, 'bob');
    harness.messages.close();
    alice.send(sendFrame(duo, IN_FLIGHT_KEY));
    await harness.messages.entered.promise;

    let drained = false;
    const draining = harness.gateway.drain();
    void draining.finally(() => {
      drained = true;
    });
    const rejected = await harness.gateway.upgrade(
      upgradeRequest(harness, `${SOCKET_PROTOCOL}, ${BEARER_PREFIX}carol`),
      harness.server,
    );
    expect(rejected?.status).toBe(503);
    await Bun.sleep(5);
    expect(drained).toBe(false);
    expect(alice.socket.readyState).toBe(WebSocket.OPEN);

    harness.messages.release();
    await draining;
    expect(harness.messages.messages).toHaveLength(1);
    expect(await alice.next('message.ack')).toMatchObject({ idempotencyKey: IN_FLIGHT_KEY });
    expect(await closeCode(alice)).toBe(CloseCode.GoingAway);
    expect(await closeCode(bob)).toBe(CloseCode.GoingAway);
    expect(harness.gateway.connectionCount()).toBe(0);
  });
});
