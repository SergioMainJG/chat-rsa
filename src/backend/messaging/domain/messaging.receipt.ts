import type { MessageStatus } from '../../../shared/contracts/messaging.contract.ts';
import type { MessageId } from './messaging.value-objects.ts';

export type ReceiptKind = 'delivered' | 'read';

/**
 * Per-member receipt watermarks. Message ids are UUIDv7, so "every message up to this id" is a
 * single comparison and a member's receipts never need a row per message.
 */
export type Watermarks = {
  readonly delivered: MessageId | null;
  readonly read: MessageId | null;
};

function later(current: MessageId | null, candidate: MessageId): MessageId {
  return current !== null && current >= candidate ? current : candidate;
}

/** Watermarks only move forward, and reading a message also marks it delivered. */
export function advanceWatermarks(
  current: Watermarks,
  kind: ReceiptKind,
  messageId: MessageId,
): Watermarks {
  const delivered = later(current.delivered, messageId);
  if (kind === 'delivered') {
    return { delivered, read: current.read };
  }
  return { delivered, read: later(current.read, messageId) };
}

export function statusFor(messageId: MessageId, marks: Watermarks): MessageStatus {
  if (marks.read !== null && messageId <= marks.read) {
    return 'read';
  }
  if (marks.delivered !== null && messageId <= marks.delivered) {
    return 'delivered';
  }
  return 'sent';
}
