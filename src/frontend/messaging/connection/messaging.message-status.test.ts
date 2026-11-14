import { describe, expect, test } from 'bun:test';

import type { ServerFrame } from '../../../shared/contracts/messaging.socket.contract.ts';

import { advanceStatus, readReceiptCovers } from './messaging.message-status.ts';

describe('advanceStatus', () => {
  test('moves forward pending -> sent -> delivered -> read', () => {
    expect(advanceStatus('pending', 'written')).toBe('sent');
    expect(advanceStatus('sent', 'acked')).toBe('delivered');
    expect(advanceStatus('delivered', 'read')).toBe('read');
  });

  test('can skip steps forward, for example an ack that arrives before the write is reported', () => {
    expect(advanceStatus('pending', 'acked')).toBe('delivered');
    expect(advanceStatus('sent', 'read')).toBe('read');
  });

  test('never moves backwards', () => {
    expect(advanceStatus('read', 'acked')).toBe('read');
    expect(advanceStatus('read', 'written')).toBe('read');
    expect(advanceStatus('delivered', 'written')).toBe('delivered');
  });
});

function receipt(userId: number, read: null | string): Extract<ServerFrame, { type: 'receipt' }> {
  return { delivered: null, read, roomId: 'r', type: 'receipt', userId };
}

describe('readReceiptCovers', () => {
  const older = '0190f0a0-0000-7000-8000-000000000001';
  const newer = '0190f0a0-0000-7000-8000-000000000002';

  test('a read receipt from another member covers every message up to its id (UUIDv7 order)', () => {
    expect(readReceiptCovers(receipt(2, newer), { messageId: older, ownUserId: 1 })).toBe(true);
    expect(readReceiptCovers(receipt(2, newer), { messageId: newer, ownUserId: 1 })).toBe(true);
    expect(readReceiptCovers(receipt(2, older), { messageId: newer, ownUserId: 1 })).toBe(false);
  });

  test('ignores own receipts and receipts without a read id', () => {
    expect(readReceiptCovers(receipt(1, newer), { messageId: older, ownUserId: 1 })).toBe(false);
    expect(readReceiptCovers(receipt(2, null), { messageId: older, ownUserId: 1 })).toBe(false);
  });
});
