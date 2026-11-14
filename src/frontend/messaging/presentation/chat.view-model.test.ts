import { describe, expect, test } from 'bun:test';

import {
  displayName,
  keyChangeNotice,
  type MessageEntry,
  parseMemberNames,
  toMessageItems,
  toRoomHeader,
  toRoomItems,
  UNDECRYPTABLE_TEXT,
} from './chat.view-model.ts';

const SELF = 1;
const names = new Map([[2, 'bob']]);
const formatTime = (iso: string): string => `t:${iso}`;

function entry(overrides: Partial<MessageEntry>): MessageEntry {
  return {
    createdAt: '2026-11-12T10:00:00.000Z',
    failed: false,
    id: null,
    idempotencyKey: 'key',
    roomId: 'room',
    senderId: SELF,
    text: 'hello',
    ...overrides,
  };
}

describe('displayName', () => {
  test('self is You, known ids use their name, others a numbered fallback', () => {
    expect(displayName(SELF, SELF, names)).toBe('You');
    expect(displayName(2, SELF, names)).toBe('bob');
    expect(displayName(9, SELF, names)).toBe('User 9');
  });
});

describe('toMessageItems', () => {
  test('stored messages are ordered by UUIDv7 id; queued ones follow in queue order', () => {
    const entries = [
      entry({ id: null, idempotencyKey: 'q2', queuedOrder: 2 }),
      entry({ id: '019a0000-0000-7000-8000-000000000002', idempotencyKey: 'b', senderId: 2 }),
      entry({ id: null, idempotencyKey: 'q1', queuedOrder: 1 }),
      entry({ id: '019a0000-0000-7000-8000-000000000001', idempotencyKey: 'a' }),
    ];

    const keys = toMessageItems(entries, { formatTime, names, selfId: SELF, statuses: new Map() }).map(
      (item) => item.key,
    );

    expect(keys).toEqual(['1:a', '2:b', '1:q1', '1:q2']);
  });

  // bugs/security.bug.xml, finding 1: idempotency keys are unique per sender only, and the page
  // keys each message element by `item.key`; two senders' messages must never share one.
  test('messages of different senders that share an idempotency key get different item keys', () => {
    const items = toMessageItems(
      [
        entry({ id: '019a0000-0000-7000-8000-000000000001', idempotencyKey: 'k1', senderId: 2 }),
        entry({ id: '019a0000-0000-7000-8000-000000000002', idempotencyKey: 'k1', senderId: 3 }),
      ],
      { formatTime, names, selfId: SELF, statuses: new Map() },
    );

    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });

  test('own messages carry their status and label; other members messages carry none', () => {
    const statuses = new Map([['own', 'read' as const]]);
    const [own, other] = toMessageItems(
      [
        entry({ id: '019a0000-0000-7000-8000-000000000001', idempotencyKey: 'own' }),
        entry({ id: '019a0000-0000-7000-8000-000000000002', idempotencyKey: 'other', senderId: 2 }),
      ],
      { formatTime, names, selfId: SELF, statuses },
    );

    expect(own).toMatchObject({ own: true, sender: 'You', status: 'read', statusLabel: 'Read' });
    expect(other).toMatchObject({ own: false, sender: 'bob', status: null, statusLabel: '' });
  });

  test('an own message without a known status is pending', () => {
    const [item] = toMessageItems([entry({})], { formatTime, names, selfId: SELF, statuses: new Map() });

    expect(item).toMatchObject({ status: 'pending', statusLabel: 'Pending' });
  });

  test('a message that could not be decrypted says so', () => {
    const [item] = toMessageItems([entry({ id: 'x', senderId: 2, text: null })], {
      formatTime,
      names,
      selfId: SELF,
      statuses: new Map(),
    });

    expect(item).toMatchObject({ text: UNDECRYPTABLE_TEXT, undecryptable: true });
    expect(UNDECRYPTABLE_TEXT).toBe('Unable to decrypt');
  });

  test('a refused own message is flagged as failed and keeps its time label', () => {
    const [item] = toMessageItems([entry({ failed: true })], { formatTime, names, selfId: SELF, statuses: new Map() });

    expect(item).toMatchObject({ failed: true, statusLabel: 'Not sent', timeLabel: 't:2026-11-12T10:00:00.000Z' });
  });
});

describe('toRoomItems', () => {
  test('sorts rooms by name and flags the active one', () => {
    const items = toRoomItems(
      [
        { id: 'b', keyEpoch: 1, memberIds: [1, 2, 3], name: 'beta' },
        { id: 'a', keyEpoch: 1, memberIds: [1, 2], name: 'Alpha' },
      ],
      'b',
    );

    expect(items).toEqual([
      { active: false, id: 'a', memberCount: 2, name: 'Alpha' },
      { active: true, id: 'b', memberCount: 3, name: 'beta' },
    ]);
  });
});

describe('toRoomHeader', () => {
  test('lists members with their presence, self first', () => {
    const header = toRoomHeader(
      { id: 'r', keyEpoch: 1, memberIds: [3, 2, 1], name: 'room' },
      { names, online: new Set([1, 2]), selfId: SELF },
    );

    expect(header).toEqual({
      id: 'r',
      members: [
        { id: 1, label: 'You', online: true },
        { id: 2, label: 'bob', online: true },
        { id: 3, label: 'User 3', online: false },
      ],
      name: 'room',
    });
  });
});

describe('parseMemberNames', () => {
  test('splits on commas and spaces, trims, and drops duplicates and empties', () => {
    expect(parseMemberNames(' bob, carol  bob,,dave ')).toEqual(['bob', 'carol', 'dave']);
    expect(parseMemberNames('   ')).toEqual([]);
  });
});

describe('keyChangeNotice', () => {
  test('names the member whose security key changed (S5)', () => {
    expect(keyChangeNotice('bob')).toBe(
      'The security key of bob changed. Messages to this room are paused until you trust the new key.',
    );
  });
});
