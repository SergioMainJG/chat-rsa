import { describe, expect, test } from 'bun:test';

import {
  BEARER_PREFIX,
  CloseCode,
  type ServerFrame,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import { FakeNetwork, FakeSocket, FakeTimers, settle } from './messaging.connection.test-support.ts';
import { type ConnectionState, SocketConnection } from './messaging.connection.ts';

const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);
const ready = (expiresAt = new Date(NOW + 15 * 60_000).toISOString()): ServerFrame => ({
  expiresAt,
  roomIds: [],
  type: 'ready',
  userId: 1,
});

type Harness = {
  readonly connection: SocketConnection;
  readonly frames: unknown[];
  readonly last: () => FakeSocket;
  readonly network: FakeNetwork;
  readonly sockets: FakeSocket[];
  readonly states: ConnectionState[];
  readonly timers: FakeTimers;
};

function setup(
  options: { online?: boolean; refreshToken?: () => Promise<string>; token?: null | string } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const frames: unknown[] = [];
  const states: ConnectionState[] = [];
  const timers = new FakeTimers();
  const network = new FakeNetwork(options.online ?? true);
  const connection = new SocketConnection({
    createSocket: (url, protocols, listener) => {
      const socket = new FakeSocket(url, protocols, listener);
      sockets.push(socket);
      return socket;
    },
    getToken: () => (options.token === undefined ? 'jwt-1' : options.token),
    network,
    now: () => NOW,
    onFrame: (frame) => frames.push(frame),
    onState: (state) => states.push(state),
    random: () => 0.5,
    refreshToken: options.refreshToken ?? (async () => 'jwt-2'),
    timers,
    url: 'ws://localhost/ws',
  });
  const last = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (!socket) {
      throw new Error('No socket was created');
    }
    return socket;
  };
  return { connection, frames, last, network, sockets, states, timers };
}

describe('SocketConnection', () => {
  test('connects with the chat subprotocol and the bearer token', () => {
    const { connection, last, states } = setup();
    connection.start();
    expect(last().url).toBe('ws://localhost/ws');
    expect(last().protocols).toEqual([SOCKET_PROTOCOL, `${BEARER_PREFIX}jwt-1`]);
    expect(states).toEqual(['connecting']);
    last().open();
    expect(connection.state).toBe('open');
    expect(connection.isOpen()).toBe(true);
  });

  test('passes parsed frames on and ignores malformed ones', () => {
    const { connection, frames, last } = setup();
    connection.start();
    last().open();
    last().receive('not json');
    last().receive('42');
    last().receive({ no: 'type' });
    last().receive({ active: true, roomId: 'r', type: 'typing', userId: 2 });
    expect(frames).toEqual([{ active: true, roomId: 'r', type: 'typing', userId: 2 }]);
  });

  test('send writes JSON while open and returns false when the socket is not open', () => {
    const { connection, last } = setup();
    expect(connection.send({ roomId: 'r', type: 'room.subscribe' })).toBe(false);
    connection.start();
    expect(connection.send({ roomId: 'r', type: 'room.subscribe' })).toBe(false);
    last().open();
    expect(connection.send({ roomId: 'r', type: 'room.subscribe' })).toBe(true);
    expect(last().sentFrames()).toEqual([{ roomId: 'r', type: 'room.subscribe' }]);
  });

  test('reconnects after an unexpected close with exponentially growing delays', () => {
    const { connection, last, sockets, states, timers } = setup();
    connection.start();
    last().open();
    last().drop(1006);
    expect(connection.state).toBe('reconnecting');
    expect(connection.isOpen()).toBe(false);
    expect(timers.delays()).toEqual([500]);
    timers.runNext();
    expect(sockets).toHaveLength(2);
    last().drop(1006);
    expect(timers.delays()).toEqual([1000]);
    timers.runNext();
    last().drop(CloseCode.GoingAway);
    expect(timers.delays()).toEqual([2000]);
    expect(states).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'connecting',
      'reconnecting',
      'connecting',
      'reconnecting',
    ]);
  });

  test('the attempt counter resets on a ready frame', () => {
    const { connection, last, timers } = setup();
    connection.start();
    last().drop(1006);
    timers.runNext();
    last().drop(1006);
    timers.runNext();
    last().open();
    last().receive(ready());
    last().drop(1006);
    expect(timers.delays().at(-1)).toBe(500);
  });

  test('does not retry while offline and reconnects immediately when the network recovers', () => {
    const { connection, last, network, sockets, timers } = setup();
    connection.start();
    last().open();
    network.set(false);
    last().drop(1006);
    expect(connection.state).toBe('offline');
    expect(timers.delays()).toEqual([]);
    network.set(true);
    expect(sockets).toHaveLength(2);
    expect(connection.state).toBe('connecting');
  });

  test('going offline cancels a pending retry; starting offline waits for the network', () => {
    const offline = setup({ online: false });
    offline.connection.start();
    expect(offline.sockets).toHaveLength(0);
    expect(offline.connection.state).toBe('offline');
    offline.network.set(true);
    expect(offline.sockets).toHaveLength(1);

    const { connection, last, network, sockets, timers } = setup();
    connection.start();
    last().drop(1006);
    expect(timers.delays()).toEqual([500]);
    network.set(false);
    expect(timers.delays()).toEqual([]);
    expect(connection.state).toBe('offline');
    network.set(true);
    expect(sockets).toHaveLength(2);
  });

  test('close code 4001 stops reconnecting and enters unauthorized', () => {
    const { connection, last, network, sockets, timers } = setup();
    connection.start();
    last().open();
    last().drop(CloseCode.AuthFailed);
    expect(connection.state).toBe('unauthorized');
    expect(timers.delays()).toEqual([]);
    network.set(false);
    network.set(true);
    expect(sockets).toHaveLength(1);
  });

  test('a missing token enters unauthorized without opening a socket', () => {
    const { connection, sockets } = setup({ token: null });
    connection.start();
    expect(sockets).toHaveLength(0);
    expect(connection.state).toBe('unauthorized');
  });

  test('close() stops for good: the socket closes normally and nothing reconnects', () => {
    const { connection, last, network, sockets, timers } = setup();
    connection.start();
    last().open();
    connection.close();
    expect(last().closedWith).toBe(1000);
    expect(connection.state).toBe('closed');
    last().drop(1000);
    network.set(false);
    network.set(true);
    expect(timers.delays()).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(connection.state).toBe('closed');
  });

  test('schedules a refresh 60 s before expiry and sends auth.refresh with the new token', async () => {
    const { connection, last, timers } = setup();
    connection.start();
    last().open();
    last().receive(ready(new Date(NOW + 10 * 60_000).toISOString()));
    expect(timers.delays()).toEqual([9 * 60_000]);
    timers.runNext();
    await settle();
    expect(last().sentFrames()).toEqual([{ token: 'jwt-2', type: 'auth.refresh' }]);
    last().receive({ expiresAt: new Date(NOW + 5 * 60_000).toISOString(), type: 'auth.refreshed' });
    expect(timers.delays()).toEqual([4 * 60_000]);
  });

  test('a token that expires within 60 s is refreshed at once', () => {
    const { connection, last, timers } = setup();
    connection.start();
    last().open();
    last().receive(ready(new Date(NOW + 30_000).toISOString()));
    expect(timers.delays()).toEqual([0]);
  });

  test('a rejected refresh enters unauthorized and closes the socket without reconnecting', async () => {
    const { connection, last, timers } = setup({
      refreshToken: async () => {
        throw new Error('refresh denied');
      },
    });
    connection.start();
    last().open();
    last().receive(ready());
    timers.runNext();
    await settle();
    expect(connection.state).toBe('unauthorized');
    expect(last().closedWith).toBe(1000);
    last().drop(1000);
    expect(timers.delays()).toEqual([]);
    expect(connection.state).toBe('unauthorized');
  });

  test('a close cancels the scheduled refresh', () => {
    const { connection, last, timers } = setup();
    connection.start();
    last().open();
    last().receive(ready());
    last().drop(1006);
    expect(timers.delays()).toEqual([500]);
  });
});
