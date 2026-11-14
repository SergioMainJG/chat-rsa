import { describe, expect, test } from 'bun:test';

import { advanceWatermarks, statusFor } from './messaging.receipt.ts';
import { MessageId } from './messaging.value-objects.ts';

const OLD = MessageId.restore('01a1d2f6-0000-7000-8000-000000000001');
const MID = MessageId.restore('01a1d2f6-0000-7000-8000-000000000002');
const NEW = MessageId.restore('01a1d2f6-0000-7000-8000-000000000003');

describe('advanceWatermarks', () => {
  test('delivered moves forward only', () => {
    const start = { delivered: MID, read: null };
    expect(advanceWatermarks(start, 'delivered', NEW)).toEqual({ delivered: NEW, read: null });
    expect(advanceWatermarks(start, 'delivered', OLD)).toEqual(start);
  });

  test('reading a message also marks it delivered', () => {
    expect(advanceWatermarks({ delivered: null, read: null }, 'read', MID)).toEqual({ delivered: MID, read: MID });
  });

  test('read never moves backwards', () => {
    const start = { delivered: NEW, read: MID };
    expect(advanceWatermarks(start, 'read', OLD)).toEqual(start);
  });
});

describe('statusFor', () => {
  test('follows sent -> delivered -> read from the watermarks', () => {
    const marks = { delivered: MID, read: OLD };
    expect(statusFor(OLD, marks)).toBe('read');
    expect(statusFor(MID, marks)).toBe('delivered');
    expect(statusFor(NEW, marks)).toBe('sent');
  });
});
