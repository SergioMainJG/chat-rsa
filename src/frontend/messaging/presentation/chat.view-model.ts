import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { LocalMessageStatus } from '../connection/messaging.message-status.ts';

import { STATUS_LABEL } from './chat.status.ts';

/** A message as the page keeps it: stored (with an id) or still queued in the outbox. */
export type MessageEntry = {
  /** Server time once stored; the queue time (client clock) while still queued. */
  readonly createdAt: string;
  /** The server refused it for good; it was removed from the outbox. */
  readonly failed: boolean;
  /** The UUIDv7 id, or null while the message is still queued. */
  readonly id: null | string;
  readonly idempotencyKey: string;
  /** Position in the outbox, for queued messages; stored ones are ordered by id. */
  readonly queuedOrder?: number;
  readonly roomId: string;
  readonly senderId: number;
  /** The plaintext, or null when it could not be decrypted. */
  readonly text: null | string;
};

export type MessageItem = {
  readonly failed: boolean;
  readonly id: null | string;
  /** Stable key for the DOM: the idempotency key, which a queued message keeps once stored. */
  readonly key: string;
  readonly own: boolean;
  readonly sender: string;
  /** Own messages only; null for other members' messages. */
  readonly status: LocalMessageStatus | null;
  readonly statusLabel: string;
  readonly text: string;
  readonly time: string;
  readonly timeLabel: string;
  readonly undecryptable: boolean;
};

export type RoomHeader = {
  readonly id: string;
  readonly members: ReadonlyArray<{
    readonly id: number;
    readonly label: string;
    readonly online: boolean;
  }>;
  readonly name: string;
};

export type RoomItem = {
  readonly active: boolean;
  readonly id: string;
  readonly memberCount: number;
  readonly name: string;
};

export const FAILED_LABEL = 'Not sent';
export const UNDECRYPTABLE_TEXT = 'Unable to decrypt';

const MEMBER_SEPARATOR = /[\s,]+/u;

export function displayName(
  userId: number,
  selfId: number,
  names: ReadonlyMap<number, string>,
): string {
  if (userId === selfId) {
    return 'You';
  }
  return names.get(userId) ?? `User ${userId}`;
}

/** Member names typed in a form: separated by commas or spaces, without duplicates. */
export function parseMemberNames(input: string): string[] {
  return [...new Set(input.split(MEMBER_SEPARATOR).filter((name) => name !== ''))];
}

/** Stored messages in UUIDv7 order (server chronology, S5), then queued ones in outbox order. */
export function toMessageItems(
  entries: Iterable<MessageEntry>,
  context: {
    readonly formatTime: (iso: string) => string;
    readonly names: ReadonlyMap<number, string>;
    readonly selfId: number;
    readonly statuses: ReadonlyMap<string, LocalMessageStatus>;
  },
): MessageItem[] {
  return [...entries].toSorted(compareEntries).map((entry) => toMessageItem(entry, context));
}

export function toRoomHeader(
  room: RoomSummary,
  context: {
    readonly names: ReadonlyMap<number, string>;
    readonly online: ReadonlySet<number>;
    readonly selfId: number;
  },
): RoomHeader {
  const { names, online, selfId } = context;
  const members = room.memberIds
    .toSorted((left, right) => {
      if (left === selfId || right === selfId) {
        return left === selfId ? -1 : 1;
      }
      return left - right;
    })
    .map((id) => ({ id, label: displayName(id, selfId, names), online: online.has(id) }));
  return { id: room.id, members, name: room.name };
}

export function toRoomItems(rooms: Iterable<RoomSummary>, activeId: null | string): RoomItem[] {
  return [...rooms]
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((room) => ({
      active: room.id === activeId,
      id: room.id,
      memberCount: room.memberIds.length,
      name: room.name,
    }));
}

function compareEntries(left: MessageEntry, right: MessageEntry): number {
  if (left.id !== null && right.id !== null) {
    return left.id < right.id ? -1 : Number(left.id > right.id);
  }
  if (left.id !== null || right.id !== null) {
    return left.id === null ? 1 : -1;
  }
  return (left.queuedOrder ?? 0) - (right.queuedOrder ?? 0);
}

function statusLabelOf(entry: MessageEntry, status: LocalMessageStatus | null): string {
  if (entry.failed) {
    return FAILED_LABEL;
  }
  return status === null ? '' : STATUS_LABEL[status];
}

function toMessageItem(
  entry: MessageEntry,
  context: {
    readonly formatTime: (iso: string) => string;
    readonly names: ReadonlyMap<number, string>;
    readonly selfId: number;
    readonly statuses: ReadonlyMap<string, LocalMessageStatus>;
  },
): MessageItem {
  const own = entry.senderId === context.selfId;
  const status = own ? (context.statuses.get(entry.idempotencyKey) ?? 'pending') : null;
  return {
    failed: entry.failed,
    id: entry.id,
    key: entry.idempotencyKey,
    own,
    sender: displayName(entry.senderId, context.selfId, context.names),
    status,
    statusLabel: statusLabelOf(entry, status),
    text: entry.text ?? UNDECRYPTABLE_TEXT,
    time: entry.createdAt,
    timeLabel: context.formatTime(entry.createdAt),
    undecryptable: entry.text === null,
  };
}
