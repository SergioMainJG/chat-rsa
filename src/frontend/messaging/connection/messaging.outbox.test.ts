import { describe, expect, test } from 'bun:test';

import { InMemoryOutbox, newOutboxItem, type OutboxItem } from './messaging.outbox.ts';

function item(key: string, queuedAt = '2026-11-12T10:00:00.000Z'): OutboxItem {
  return { idempotencyKey: key, queuedAt, roomId: 'room-1', text: `text ${key}` };
}

describe('newOutboxItem', () => {
  test('stores the plaintext with a fresh idempotency key and the queue time', () => {
    const created = newOutboxItem('room-1', 'hello', { now: () => Date.UTC(2026, 10, 12), randomUUID: () => 'k-1' });
    expect(created).toEqual({
      idempotencyKey: 'k-1',
      queuedAt: '2026-11-12T00:00:00.000Z',
      roomId: 'room-1',
      text: 'hello',
    });
  });
});

describe('InMemoryOutbox', () => {
  test('lists items oldest first in enqueue order (stable FIFO, even with equal timestamps)', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(item('c'));
    await outbox.enqueue(item('a'));
    await outbox.enqueue(item('b'));
    const list = await outbox.list();
    expect(list.map((entry) => entry.idempotencyKey)).toEqual(['c', 'a', 'b']);
  });

  test('remove drops only the item with that key and keeps the order of the rest', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(item('a'));
    await outbox.enqueue(item('b'));
    await outbox.enqueue(item('c'));
    await outbox.remove('b');
    const list = await outbox.list();
    expect(list.map((entry) => entry.idempotencyKey)).toEqual(['a', 'c']);
  });

  test('get returns the item by key, or null', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(item('a'));
    expect(await outbox.get('a')).toEqual(item('a'));
    expect(await outbox.get('missing')).toBeNull();
  });

  test('enqueueing an existing key keeps the original item and position', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(item('a'));
    await outbox.enqueue(item('b'));
    await outbox.enqueue({ ...item('a'), text: 'changed' });
    const list = await outbox.list();
    expect(list.map((entry) => entry.idempotencyKey)).toEqual(['a', 'b']);
    expect(list[0]?.text).toBe('text a');
  });

  test('list returns a snapshot that later changes do not mutate', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(item('a'));
    const snapshot = await outbox.list();
    await outbox.remove('a');
    expect(snapshot).toHaveLength(1);
  });
});
