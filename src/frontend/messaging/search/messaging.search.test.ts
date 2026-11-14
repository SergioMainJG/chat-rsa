import { describe, expect, test } from 'bun:test';

import {
  InMemoryLocalMessageStore,
  type LocalMessage,
  matchesQuery,
  searchMessages,
  tokenize,
} from './messaging.search.ts';

const ROOM = '019a0000-0000-7000-8000-000000000001';
const OTHER_ROOM = '019a0000-0000-7000-8000-000000000002';

function message(id: number, text: string, roomId = ROOM): LocalMessage {
  return {
    createdAt: `2026-11-12T00:00:0${id}.000Z`,
    id: `019a0000-0000-7000-8000-00000000000${id}`,
    roomId,
    senderId: 1,
    text,
  };
}

describe('tokenize', () => {
  test('lowercases, strips diacritics and splits on anything that is not a letter or digit', () => {
    expect(tokenize('¡Café, CON leche!  Ñandú-42')).toEqual(['cafe', 'con', 'leche', 'nandu', '42']);
  });
});

describe('matchesQuery', () => {
  test('matches case- and diacritic-insensitively, in both directions', () => {
    expect(matchesQuery('Un café con leche', 'CAFE')).toBe(true);
    expect(matchesQuery('un cafe con leche', 'Café')).toBe(true);
    expect(matchesQuery('el ñandú corre', 'NANDU')).toBe(true);
  });

  test('requires every query term, each as a word prefix', () => {
    expect(matchesQuery('un café con leche', 'leche caf')).toBe(true);
    expect(matchesQuery('un café con leche', 'cafe te')).toBe(false);
    expect(matchesQuery('un café con leche', 'eche')).toBe(false);
  });

  test('an empty query matches nothing', () => {
    expect(matchesQuery('anything', '   ')).toBe(false);
  });
});

describe('searchMessages', () => {
  test('returns the matches newest first, optionally within one room', () => {
    const messages = [
      message(1, 'café'),
      message(3, 'otro café', OTHER_ROOM),
      message(2, 'más café'),
      message(4, 'té'),
    ];

    expect(searchMessages(messages, 'cafe').map(({ id }) => id.at(-1))).toEqual(['3', '2', '1']);
    expect(searchMessages(messages, 'cafe', ROOM).map(({ id }) => id.at(-1))).toEqual(['2', '1']);
  });
});

describe('InMemoryLocalMessageStore', () => {
  test('replaces a message with the same id and lists a room oldest first', async () => {
    const store = new InMemoryLocalMessageStore();

    await store.put(message(2, 'second'));
    await store.put(message(1, 'first'));
    await store.put(message(3, 'elsewhere', OTHER_ROOM));
    await store.put({ ...message(1, 'first, edited') });

    const listed = await store.listByRoom(ROOM);

    expect(listed.map(({ text }) => text)).toEqual(['first, edited', 'second']);
  });

  test('searches the stored messages', async () => {
    const store = new InMemoryLocalMessageStore();
    await store.put(message(1, 'Reunión mañana'));
    await store.put(message(2, 'reunion cancelada', OTHER_ROOM));

    const everywhere = await store.search('REUNION');
    const inRoom = await store.search('reunion manana', ROOM);

    expect(everywhere.map(({ id }) => id.at(-1))).toEqual(['2', '1']);
    expect(inRoom.map(({ id }) => id.at(-1))).toEqual(['1']);
  });
});
