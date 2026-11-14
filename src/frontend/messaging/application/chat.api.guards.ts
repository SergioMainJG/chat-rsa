// Shape checks for REST response bodies: the page never trusts a body it did not check.
import type { AuthResponse, PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type {
  HistoryPage,
  IdentityKeyView,
  MessageView,
  RoomSummary,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';

/** One member's receipt watermarks in a room (GET /api/rooms/:roomId/receipts). */
export type RoomReceipt = {
  readonly delivered: null | string;
  readonly read: null | string;
  readonly userId: number;
};

type Guard<T> = (value: unknown) => value is T;

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every((item) => guard(item));
}

export function isAuthResponse(value: unknown): value is AuthResponse {
  return isRecord(value) && isNonEmptyString(value.token) && isPublicUser(value.user);
}

export function isHistoryPage(value: unknown): value is HistoryPage {
  return (
    isRecord(value) &&
    arrayOf(isMessageView)(value.messages) &&
    (value.nextBefore === null || typeof value.nextBefore === 'string')
  );
}

export function isIdentityKeyView(value: unknown): value is IdentityKeyView {
  return isRecord(value) && isNonEmptyString(value.publicKey) && Number.isInteger(value.userId);
}

export function isMessageView(value: unknown): value is MessageView {
  return (
    isEncrypted(value) &&
    Number.isInteger(value.chainIndex) &&
    typeof value.createdAt === 'string' &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.idempotencyKey) &&
    Number.isInteger(value.keyEpoch) &&
    isNonEmptyString(value.roomId) &&
    Number.isInteger(value.senderId)
  );
}

export function isPublicUser(value: unknown): value is PublicUser {
  return isRecord(value) && Number.isInteger(value.id) && typeof value.name === 'string';
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

export function isRoomReceipt(value: unknown): value is RoomReceipt {
  return (
    isRecord(value) &&
    isNullableString(value.delivered) &&
    isNullableString(value.read) &&
    Number.isInteger(value.userId)
  );
}

export function isRoomSummary(value: unknown): value is RoomSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    Number.isInteger(value.keyEpoch) &&
    Array.isArray(value.memberIds) &&
    value.memberIds.every((id) => Number.isInteger(id)) &&
    typeof value.name === 'string'
  );
}

export function isSenderKeyEnvelopeView(value: unknown): value is SenderKeyEnvelopeView {
  return (
    isEncrypted(value) &&
    isNonEmptyString(value.ephemeralPublicKey) &&
    Number.isInteger(value.keyEpoch) &&
    Number.isInteger(value.recipientId) &&
    isNonEmptyString(value.roomId) &&
    Number.isInteger(value.senderId)
  );
}

function isEncrypted(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    typeof value.authTag === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.iv === 'string'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is null | string {
  return value === null || typeof value === 'string';
}
