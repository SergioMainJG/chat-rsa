import type { ConnectionState } from '../connection/messaging.connection.ts';

import {
  advanceStatus,
  type LocalMessageStatus,
  type StatusEvent,
} from '../connection/messaging.message-status.ts';

export const STATUS_LABEL: Readonly<Record<LocalMessageStatus, string>> = {
  delivered: 'Delivered',
  pending: 'Pending',
  read: 'Read',
  sent: 'Sent',
};

const EVENT_FOR: Readonly<Record<Exclude<LocalMessageStatus, 'pending'>, StatusEvent>> = {
  delivered: 'acked',
  read: 'read',
  sent: 'written',
};

const BANNER: Readonly<Record<ConnectionState, string>> = {
  closed: '',
  connecting: 'Connecting…',
  offline: 'You are offline. Messages you send are kept and sent when the connection returns.',
  open: '',
  reconnecting: 'Connection lost. Reconnecting…',
  unauthorized: 'Your session has ended. Sign in again.',
};

export function connectionBannerText(state: ConnectionState): string {
  return BANNER[state];
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
