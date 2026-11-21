import { describe, expect, test } from 'bun:test';

import type { ClientFrame, ServerFrame } from '../../../shared/contracts/messaging.socket.contract.ts';
import type { LocalMessageStatus } from './messaging.message-status.ts';

import { FakeTimers, settle } from './messaging.connection.test-support.ts';
import { type FlushStop, OutboxFlusher, type SendFrame } from './messaging.outbox-flusher.ts';
import { InMemoryOutbox, type OutboxItem } from './messaging.outbox.ts';

type Harness = {
  readonly connection: FakeConnection;
  readonly flusher: OutboxFlusher;
  readonly outbox: InMemoryOutbox;
  readonly queuedKeys: () => Promise<string[]>;
  readonly rotateEpoch: () => void;
  readonly sentKeys: () => string[];
  readonly statuses: Array<[string, LocalMessageStatus]>;
  readonly stops: FlushStop[];
  readonly timers: FakeTimers;
};

class FakeConnection {
  open = true;
  /** The socket still reports open but refuses the frame (it is closing). */
  refuse = false;
  readonly sent: SendFrame[] = [];

  isOpen = (): boolean => this.open;

  send = (frame: ClientFrame): boolean => {
    if (!this.open || this.refuse) {
      return false;
    }
    if (frame.type === 'message.send') {
      this.sent.push(frame);
    }
    return true;
  };
}

function ack(idempotencyKey: string): ServerFrame {
  return {
    duplicate: false,
    idempotencyKey,
    message: {
      authTag: 't',
      chainIndex: 0,
      ciphertext: 'c',
      createdAt: '2026-11-12T10:00:00.000Z',
      id: `id-${idempotencyKey}`,
      idempotencyKey,
      iv: 'i',
      keyEpoch: 1,
      roomId: 'room-1',
      senderId: 1,
    },
    type: 'message.ack',
  };
}

function error(ref: string, code: 'conflict' | 'forbidden'): ServerFrame {
  return { code, message: code, ref, type: 'error' };
}

function setup(): Harness {
  const outbox = new InMemoryOutbox();
  const connection = new FakeConnection();
  const timers = new FakeTimers();
  const statuses: Array<[string, LocalMessageStatus]> = [];
  const stops: FlushStop[] = [];
  let epoch = 1;
  let keys = 0;
  const flusher = new OutboxFlusher({
    ackTimeoutMs: 10_000,
    connection,
    encrypt: async (item: OutboxItem): Promise<SendFrame> => ({
      authTag: 't',
      chainIndex: 0,
      ciphertext: item.text,
      idempotencyKey: item.idempotencyKey,
      iv: 'i',
      keyEpoch: epoch,
      roomId: item.roomId,
      type: 'message.send',
    }),
    now: () => Date.UTC(2026, 10, 12),
    onStatus: (key, status) => statuses.push([key, status]),
    onStop: (stop) => stops.push(stop),
    outbox,
    randomUUID: () => {
      keys += 1;
      return `k${keys}`;
    },
    timers,
  });
  const sentKeys = (): string[] => connection.sent.map((frame) => frame.idempotencyKey);
  const queuedKeys = async (): Promise<string[]> => {
    const items = await outbox.list();
    return items.map((item) => item.idempotencyKey);
  };
  const rotateEpoch = (): void => {
    epoch += 1;
  };
  return { connection, flusher, outbox, queuedKeys, rotateEpoch, sentKeys, statuses, stops, timers };
}

describe('OutboxFlusher', () => {
  test('sending goes through the outbox: the item is queued as pending before it is sent', async () => {
    const { connection, flusher, queuedKeys, statuses } = setup();
    connection.open = false;
    const item = await flusher.enqueue('room-1', 'hello');
    expect(item).toEqual({
      idempotencyKey: 'k1',
      queuedAt: '2026-11-12T00:00:00.000Z',
      roomId: 'room-1',
      text: 'hello',
    });
    await settle();
    expect(await queuedKeys()).toEqual(['k1']);
    expect(connection.sent).toEqual([]);
    expect(statuses).toEqual([['k1', 'pending']]);
  });

  test('sends strictly in order, one at a time, waiting for each ack', async () => {
    const { flusher, queuedKeys, sentKeys, statuses } = setup();
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await flusher.enqueue('room-1', 'three');
    await settle();
    expect(sentKeys()).toEqual(['k1']);
    flusher.handleFrame(ack('k2'));
    await settle();
    expect(sentKeys()).toEqual(['k1']);
    flusher.handleFrame(ack('k1'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2']);
    flusher.handleFrame(ack('k2'));
    await settle();
    flusher.handleFrame(ack('k3'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2', 'k3']);
    expect(await queuedKeys()).toEqual([]);
    expect(statuses.filter(([key]) => key === 'k1')).toEqual([
      ['k1', 'pending'],
      ['k1', 'sent'],
      ['k1', 'delivered'],
    ]);
  });

  test('flushes items queued while offline, oldest first, once the connection is ready', async () => {
    const { connection, flusher, sentKeys } = setup();
    connection.open = false;
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await settle();
    connection.open = true;
    flusher.onReady();
    await settle();
    expect(sentKeys()).toEqual(['k1']);
    flusher.handleFrame(ack('k1'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2']);
  });

  test('a disconnect mid-flush keeps the remaining items and resumes in order with the same keys', async () => {
    const { connection, flusher, queuedKeys, sentKeys, stops } = setup();
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await flusher.enqueue('room-1', 'three');
    await settle();
    flusher.handleFrame(ack('k1'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2']);
    connection.open = false;
    flusher.onDisconnect();
    await settle();
    expect(stops).toEqual([{ idempotencyKey: 'k2', reason: 'disconnected' }]);
    expect(await queuedKeys()).toEqual(['k2', 'k3']);
    connection.open = true;
    flusher.onReady();
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2', 'k2']);
    flusher.handleFrame(ack('k2'));
    await settle();
    flusher.handleFrame(ack('k3'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k2', 'k2', 'k3']);
    expect(await queuedKeys()).toEqual([]);
  });

  test('an ack timeout stops the flush and leaves the item queued until the next ready', async () => {
    const { flusher, queuedKeys, sentKeys, stops, timers } = setup();
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await settle();
    expect(timers.delays()).toEqual([10_000]);
    timers.runNext();
    await settle();
    expect(stops).toEqual([{ idempotencyKey: 'k1', reason: 'ack-timeout' }]);
    await flusher.enqueue('room-1', 'three');
    await settle();
    expect(sentKeys()).toEqual(['k1']);
    expect(await queuedKeys()).toEqual(['k1', 'k2', 'k3']);
    flusher.onReady();
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k1']);
  });

  test('a ready on a new connection while an ack is pending resends that item at once with the same key', async () => {
    const { flusher, sentKeys, stops } = setup();
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await settle();
    flusher.onReady();
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k1']);
    expect(stops).toEqual([]);
    flusher.handleFrame(ack('k1'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k1', 'k2']);
  });

  test('a ready while the only queued item awaits its ack resends it at once', async () => {
    const { flusher, sentKeys, stops } = setup();
    await flusher.enqueue('room-1', 'one');
    await settle();
    expect(sentKeys()).toEqual(['k1']);

    flusher.onReady();
    await settle();

    expect(sentKeys()).toEqual(['k1', 'k1']);
    expect(stops).toEqual([]);
  });

  test('a send the socket refuses stops the flush as disconnected and keeps the item queued', async () => {
    const { connection, flusher, queuedKeys, statuses, stops, timers } = setup();
    connection.refuse = true;
    await flusher.enqueue('room-1', 'one');
    await settle();

    expect(stops).toEqual([{ idempotencyKey: 'k1', reason: 'disconnected' }]);
    expect(statuses).toEqual([['k1', 'pending']]);
    expect(timers.delays()).toEqual([]);
    expect(await queuedKeys()).toEqual(['k1']);
  });

  test('a conflict error re-encrypts and retries the item once with the same key', async () => {
    const { connection, flusher, rotateEpoch, sentKeys, stops } = setup();
    await flusher.enqueue('room-1', 'one');
    await settle();
    rotateEpoch();
    flusher.handleFrame(error('k1', 'conflict'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k1']);
    expect(connection.sent.map((frame) => frame.keyEpoch)).toEqual([1, 2]);
    flusher.handleFrame(error('k1', 'conflict'));
    await settle();
    expect(sentKeys()).toEqual(['k1', 'k1']);
    expect(stops).toEqual([
      { error: { code: 'conflict', message: 'conflict' }, idempotencyKey: 'k1', reason: 'rejected' },
    ]);
  });

  test('another error code stops the flush and reports it, keeping the item queued', async () => {
    const { flusher, queuedKeys, sentKeys, stops } = setup();
    await flusher.enqueue('room-1', 'one');
    await flusher.enqueue('room-1', 'two');
    await settle();
    flusher.handleFrame(error('other-ref', 'forbidden'));
    flusher.handleFrame(error('k1', 'forbidden'));
    await settle();
    expect(stops).toEqual([
      { error: { code: 'forbidden', message: 'forbidden' }, idempotencyKey: 'k1', reason: 'rejected' },
    ]);
    expect(sentKeys()).toEqual(['k1']);
    expect(await queuedKeys()).toEqual(['k1', 'k2']);
  });

  test('a ready frame passed to handleFrame resumes the flush', async () => {
    const { connection, flusher, sentKeys } = setup();
    connection.open = false;
    await flusher.enqueue('room-1', 'one');
    await settle();
    connection.open = true;
    flusher.handleFrame({ expiresAt: '2026-11-12T11:00:00.000Z', roomIds: [], type: 'ready', userId: 1 });
    await settle();
    expect(sentKeys()).toEqual(['k1']);
  });

  test('only one flush runs at a time', async () => {
    const { flusher, sentKeys } = setup();
    await flusher.enqueue('room-1', 'one');
    void flusher.flush();
    void flusher.flush();
    flusher.onReady();
    await settle();
    expect(sentKeys()).toEqual(['k1']);
  });

  test('an encryption failure stops the flush and keeps the item', async () => {
    const outbox = new InMemoryOutbox();
    const stops: FlushStop[] = [];
    const statuses: LocalMessageStatus[] = [];
    const flusher = new OutboxFlusher({
      ackTimeoutMs: 1000,
      connection: new FakeConnection(),
      encrypt: async () => {
        throw new Error('no sender key');
      },
      now: () => 0,
      onStatus: (_key, status) => statuses.push(status),
      onStop: (stop) => stops.push(stop),
      outbox,
      randomUUID: () => 'k1',
      timers: new FakeTimers(),
    });
    await flusher.enqueue('room-1', 'one');
    await settle();
    expect(stops).toEqual([{ idempotencyKey: 'k1', reason: 'encrypt-failed' }]);
    expect(statuses).toEqual(['pending']);
    expect(await outbox.list()).toHaveLength(1);
  });
});
