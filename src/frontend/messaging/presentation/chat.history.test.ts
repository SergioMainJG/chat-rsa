import { describe, expect, test } from 'bun:test';

import { HistoryCursor } from './chat.history.ts';

const CURSOR = '019a0000-0000-7000-8000-000000000005';

describe('HistoryCursor', () => {
  test('the first page is requested without a cursor', () => {
    const cursor = new HistoryCursor();

    expect(cursor.hasOlder).toBe(true);
    expect(cursor.begin()).toEqual({});
  });

  test('a page request in flight blocks another one', () => {
    const cursor = new HistoryCursor();
    cursor.begin();

    expect(cursor.begin()).toBeNull();
  });

  test('the next page is requested before the previous page nextBefore', () => {
    const cursor = new HistoryCursor();
    cursor.begin();
    cursor.apply({ messages: [], nextBefore: CURSOR });

    expect(cursor.hasOlder).toBe(true);
    expect(cursor.begin()).toEqual({ before: CURSOR });
  });

  test('a null nextBefore means there is nothing older', () => {
    const cursor = new HistoryCursor();
    cursor.begin();
    cursor.apply({ messages: [], nextBefore: null });

    expect(cursor.hasOlder).toBe(false);
    expect(cursor.begin()).toBeNull();
  });

  test('a failed request can be retried with the same cursor', () => {
    const cursor = new HistoryCursor();
    cursor.begin();
    cursor.apply({ messages: [], nextBefore: CURSOR });
    cursor.begin();
    cursor.fail();

    expect(cursor.begin()).toEqual({ before: CURSOR });
  });
});
