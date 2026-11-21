import type { ConnectionState } from '../connection/messaging.connection.ts';

import { messages } from '../../i18n/i18n.messages.ts';
import {
  advanceStatus,
  type LocalMessageStatus,
  type StatusEvent,
} from '../connection/messaging.message-status.ts';

/** The label of a message status, in the page's language. */
export function statusLabel(status: LocalMessageStatus): string {
  return messages().status[status];
}

const EVENT_FOR: Readonly<Record<Exclude<LocalMessageStatus, 'pending'>, StatusEvent>> = {
  delivered: 'acked',
  read: 'read',
  sent: 'written',
};

export function connectionBannerText(state: ConnectionState): string {
  return messages().banner[state];
}

/**
 * The status to render after `incoming`. It only moves forward (through `advanceStatus`), so an ack
 * that arrives after a read receipt, or a resend after an ack, never moves it back.
 */
export function mergeStatus(
  current: LocalMessageStatus | undefined,
  incoming: LocalMessageStatus,
): LocalMessageStatus {
  if (current === undefined) {
    return incoming;
  }
  return incoming === 'pending' ? current : advanceStatus(current, EVENT_FOR[incoming]);
}
