import type { ServerFrame } from '../../../shared/contracts/messaging.socket.contract.ts';

/**
 * Local delivery state of an own message: `pending` (queued in the outbox), `sent` (frame written
 * to the socket), `delivered` (the server's `message.ack`: persisted), `read` (another member's
 * read receipt covers it).
 */
export type LocalMessageStatus = 'delivered' | 'pending' | 'read' | 'sent';

/** What happened to the message: written to the socket, acknowledged, or read by someone else. */
export type StatusEvent = 'acked' | 'read' | 'written';

type ReceiptFrame = Extract<ServerFrame, { type: 'receipt' }>;

const RANK: Readonly<Record<LocalMessageStatus, number>> = {
  delivered: 2,
  pending: 0,
  read: 3,
  sent: 1,
};

const TARGET: Readonly<Record<StatusEvent, LocalMessageStatus>> = {
  acked: 'delivered',
  read: 'read',
  written: 'sent',
};

/** Applies an event; the status only moves forward, so a late or repeated event is a no-op. */
export function advanceStatus(current: LocalMessageStatus, event: StatusEvent): LocalMessageStatus {
  const target = TARGET[event];
  return RANK[target] > RANK[current] ? target : current;
}

/**
 * True when a receipt from another member marks the message as read. A read receipt names the
 * newest message the member has seen; message ids are UUIDv7, so comparing them as strings compares
 * their server-side creation order, and every older message is covered too.
 */
export function readReceiptCovers(
  receipt: ReceiptFrame,
  { messageId, ownUserId }: { readonly messageId: string; readonly ownUserId: number },
): boolean {
  return receipt.userId !== ownUserId && receipt.read !== null && messageId <= receipt.read;
}
