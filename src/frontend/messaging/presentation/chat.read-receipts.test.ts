import { describe, expect, test } from 'bun:test';

import { pickReadReceipt, ReadReceiptTracker } from './chat.read-receipts.ts';

// UUIDv7 ids compare as strings in creation order.
const OLDEST = '019a0000-0000-7000-8000-000000000001';
const MIDDLE = '019a0000-0000-7000-8000-000000000002';
const NEWEST = '019a0000-0000-7000-8000-000000000003';

describe('pickReadReceipt', () => {
  test('picks only the newest visible id; the server watermark covers the older ones', () => {
    expect(pickReadReceipt([OLDEST, NEWEST, MIDDLE], null)).toBe(NEWEST);
  });

  test('nothing visible sends nothing', () => {
    expect(pickReadReceipt([], null)).toBeNull();
  });

  test('a newest visible id at or below the last sent read sends nothing', () => {
    expect(pickReadReceipt([OLDEST, MIDDLE], MIDDLE)).toBeNull();
    expect(pickReadReceipt([OLDEST], MIDDLE)).toBeNull();
  });

  test('a visible id above the last sent read is sent', () => {
    expect(pickReadReceipt([OLDEST, NEWEST], MIDDLE)).toBe(NEWEST);
  });
});

describe('ReadReceiptTracker', () => {
  test('take returns the newest visible id once, then only newer ones', () => {
    const tracker = new ReadReceiptTracker();
    tracker.show('room', OLDEST);
    tracker.show('room', MIDDLE);

    expect(tracker.take('room')).toBe(MIDDLE);
    expect(tracker.take('room')).toBeNull();

    tracker.show('room', NEWEST);
    expect(tracker.take('room')).toBe(NEWEST);
  });

  test('a message that left the viewport is not read', () => {
    const tracker = new ReadReceiptTracker();
    tracker.show('room', OLDEST);
    tracker.hide('room', OLDEST);

    expect(tracker.take('room')).toBeNull();
  });

  test('the read watermark the server already has suppresses older ids', () => {
    const tracker = new ReadReceiptTracker();
    tracker.seed('room', MIDDLE);
    tracker.show('room', OLDEST);
    tracker.show('room', MIDDLE);

    expect(tracker.take('room')).toBeNull();

    tracker.show('room', NEWEST);
    expect(tracker.take('room')).toBe(NEWEST);
  });

  test('a seed never moves the watermark backwards', () => {
    const tracker = new ReadReceiptTracker();
    tracker.show('room', NEWEST);
    expect(tracker.take('room')).toBe(NEWEST);

    tracker.seed('room', OLDEST);
    expect(tracker.take('room')).toBeNull();
  });

  test('rooms are tracked independently', () => {
    const tracker = new ReadReceiptTracker();
    tracker.show('a', NEWEST);
    tracker.show('b', OLDEST);

    expect(tracker.take('a')).toBe(NEWEST);
    expect(tracker.take('b')).toBe(OLDEST);
  });
});
