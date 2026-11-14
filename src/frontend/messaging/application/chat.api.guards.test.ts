// BUG-MEDIUM-12 (S12, frontend): every response guard must reject a body with one missing or
// wrongly typed field, and arrayOf must reject an array with one bad item among good ones.
import { describe, expect, test } from 'bun:test';

import {
  arrayOf,
  isAuthResponse,
  isHistoryPage,
  isIdentityKeyView,
  isMessageView,
  isPublicUser,
  isRecord,
  isRoomReceipt,
  isRoomSummary,
  isSenderKeyEnvelopeView,
} from './chat.api.guards.ts';

type Fixture = Readonly<Record<string, unknown>>;
type Guard = (value: unknown) => boolean;

const MESSAGE: Fixture = {
  authTag: 't',
  chainIndex: 0,
  ciphertext: 'c',
  createdAt: '2026-11-12T10:00:00.000Z',
  id: '019a0000-0000-7000-8000-000000000001',
  idempotencyKey: 'k1',
  iv: 'i',
  keyEpoch: 1,
  roomId: 'r1',
  senderId: 2,
};
const USER: Fixture = { id: 1, name: 'alice' };
const ROOM: Fixture = { id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' };
const ENVELOPE: Fixture = {
  authTag: 't',
  ciphertext: 'c',
  ephemeralPublicKey: 'e',
  iv: 'i',
  keyEpoch: 1,
  recipientId: 1,
  roomId: 'r1',
  senderId: 2,
};

/** For each guard: a valid body, and per field the values it must reject. `undefined` stands for the field being absent. */
const CASES: ReadonlyArray<{
  readonly guard: Guard;
  readonly name: string;
  readonly rejects: Readonly<Record<string, readonly unknown[]>>;
  readonly valid: Fixture;
}> = [
  {
    guard: isAuthResponse,
    name: 'isAuthResponse',
    rejects: { token: [undefined, '', 7], user: [undefined, null, { id: 'one', name: 'alice' }, { id: 1 }] },
    valid: { token: 'jwt', user: USER },
  },
  {
    guard: isHistoryPage,
    name: 'isHistoryPage',
    rejects: {
      messages: [undefined, null, {}, [MESSAGE, { ...MESSAGE, senderId: '2' }]],
      nextBefore: [undefined, 5, {}],
    },
    valid: { messages: [MESSAGE], nextBefore: null },
  },
  {
    guard: isIdentityKeyView,
    name: 'isIdentityKeyView',
    rejects: { publicKey: [undefined, '', 1], userId: [undefined, '1', 1.5, null] },
    valid: { publicKey: 'pk', userId: 1 },
  },
  {
    guard: isMessageView,
    name: 'isMessageView',
    rejects: {
      authTag: [undefined, 1],
      chainIndex: [undefined, '0', 0.5],
      ciphertext: [undefined, null],
      createdAt: [undefined, 0],
      id: [undefined, '', 1],
      idempotencyKey: [undefined, '', 1],
      iv: [undefined, 1],
      keyEpoch: [undefined, '1', 1.5],
      roomId: [undefined, '', 1],
      senderId: [undefined, '2', 2.5],
    },
    valid: MESSAGE,
  },
  {
    guard: isPublicUser,
    name: 'isPublicUser',
    rejects: { id: [undefined, '1', 1.5], name: [undefined, 1, null] },
    valid: USER,
  },
  {
    guard: isRoomReceipt,
    name: 'isRoomReceipt',
    rejects: { delivered: [undefined, 1], read: [undefined, 1], userId: [undefined, '1', 1.5] },
    valid: { delivered: null, read: 'm1', userId: 2 },
  },
  {
    guard: isRoomSummary,
    name: 'isRoomSummary',
    rejects: {
      id: [undefined, '', 1],
      keyEpoch: [undefined, '1', 1.5],
      memberIds: [undefined, null, '1,2', [1, '2'], [1, 2.5]],
      name: [undefined, 1],
    },
    valid: ROOM,
  },
  {
    guard: isSenderKeyEnvelopeView,
    name: 'isSenderKeyEnvelopeView',
    rejects: {
      authTag: [undefined, 1],
      ciphertext: [undefined, 1],
      ephemeralPublicKey: [undefined, '', 1],
      iv: [undefined, 1],
      keyEpoch: [undefined, '1', 1.5],
      recipientId: [undefined, '1', 1.5],
      roomId: [undefined, '', 1],
      senderId: [undefined, '2', 2.5],
    },
    valid: ENVELOPE,
  },
];

function withField(fixture: Fixture, field: string, value: unknown): Fixture {
  const rest = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== field));
  return value === undefined ? rest : { ...rest, [field]: value };
}

describe('response guards', () => {
  for (const { guard, name, rejects, valid } of CASES) {
    describe(name, () => {
      test('accepts a valid body', () => {
        expect(guard(valid)).toBe(true);
      });

      test('rejects non-objects', () => {
        for (const value of [null, undefined, 'x', 1, true]) {
          expect(guard(value)).toBe(false);
        }
      });

      for (const [field, values] of Object.entries(rejects)) {
        test(`rejects a missing or wrongly typed ${field}`, () => {
          for (const value of values) {
            expect({ field, ok: guard(withField(valid, field, value)), value }).toEqual({ field, ok: false, value });
          }
        });
      }
    });
  }

  test('nullable fields accept null and strings', () => {
    expect(isRoomReceipt({ delivered: 'm1', read: null, userId: 2 })).toBe(true);
    expect(isHistoryPage({ messages: [], nextBefore: '019a0000-0000-7000-8000-000000000001' })).toBe(true);
  });

  test('isRecord accepts objects and arrays only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    for (const value of [null, undefined, 'x', 1, true]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('arrayOf', () => {
  const rooms = arrayOf(isRoomSummary);

  test('accepts an empty array and an array of valid items', () => {
    expect(rooms([])).toBe(true);
    expect(rooms([ROOM, { ...ROOM, id: 'r2' }])).toBe(true);
  });

  test('rejects an array with one valid and one invalid item, in either order', () => {
    const corrupted = { ...ROOM, keyEpoch: 'one' };
    expect(rooms([ROOM, corrupted])).toBe(false);
    expect(rooms([corrupted, ROOM])).toBe(false);
  });

  test('rejects a non-array, even an array-like object', () => {
    expect(rooms({ 0: ROOM, length: 1 })).toBe(false);
    expect(rooms(null)).toBe(false);
    expect(rooms(ROOM)).toBe(false);
  });
});
