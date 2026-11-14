import type { FieldError } from '../../../shared/contracts/error.contract.ts';
import type { HistoryPage } from '../../../shared/contracts/messaging.contract.ts';
import type { AppError } from '../../shared/domain/app.error.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type {
  HistoryQuery,
  MessageRepository,
  RoomRepository,
} from '../domain/messaging.repository.ts';

import { err, ok, type Result } from '../../shared/domain/result.ts';
import { MessageId, uuidV7Bound } from '../domain/messaging.value-objects.ts';
import { Fields, type Input, isAbsent, roomOfMember } from './messaging.access.ts';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Loads a page of history, newest first. `before` is the cursor from the previous page; `since`
 * (inclusive) and `until` (exclusive) are ISO 8601 server times, for example one hour.
 */
export class HistoryUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly messages: MessageRepository,
  ) {}

  async execute(
    actor: UserId,
    rawRoomId: unknown,
    query: Input,
  ): Promise<Result<HistoryPage, AppError>> {
    const bounds = historyQueryOf(query);
    if (!bounds.ok) {
      return bounds;
    }
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const { limit } = bounds.value;
    // One extra row tells whether an older page exists.
    const rows = await this.messages.page(room.value.id, { ...bounds.value, limit: limit + 1 });
    const page = rows.slice(0, limit);
    return ok({
      messages: page.map((message) => message.toView()),
      nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    });
  }
}

/** Turns the cursor and the time window into exclusive UUIDv7 bounds. */
function historyQueryOf(query: Input): Result<HistoryQuery, AppError> {
  const fields = new Fields();
  const limit = fields.take(limitOf(query.limit));
  const before = isAbsent(query.before)
    ? null
    : fields.take(MessageId.create(query.before, 'before'));
  const since = isAbsent(query.since) ? null : fields.take(timeOf(query.since, 'since'));
  const until = isAbsent(query.until) ? null : fields.take(timeOf(query.until, 'until'));
  if (
    fields.hasErrors() ||
    limit === undefined ||
    before === undefined ||
    since === undefined ||
    until === undefined
  ) {
    return err(fields.error());
  }
  if (isInverted(since, until)) {
    fields.push({ field: 'since', message: 'since must not be after until' });
    return err(fields.error());
  }
  const upper = [before, until === null ? null : uuidV7Bound(until, 'min')]
    .filter((bound) => bound !== null)
    .toSorted()[0];
  return ok({
    after: lowerBoundOf(since),
    before: upper ?? null,
    limit,
  });
}

function isInverted(since: null | number, until: null | number): boolean {
  return since !== null && until !== null && since > until;
}

function limitOf(raw: unknown): Result<number, FieldError> {
  if (isAbsent(raw)) {
    return ok(DEFAULT_PAGE_SIZE);
  }
  const value = typeof raw === 'string' && /^\d{1,3}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    return err({ field: 'limit', message: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` });
  }
  return ok(value);
}

/** `since` is inclusive; at millisecond 0 nothing is older, so there is no lower bound at all. */
function lowerBoundOf(since: null | number): MessageId | null {
  return since === null || since === 0 ? null : uuidV7Bound(since - 1, 'max');
}

function timeOf(raw: unknown, field: string): Result<number, FieldError> {
  const ms =
    typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(raw) ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) {
    return err({ field, message: `${field} must be an ISO 8601 date` });
  }
  // UUIDv7 cannot encode an earlier time; clamping would silently widen or empty the window.
  return ms < 0
    ? err({ field, message: `${field} must not be before 1970-01-01T00:00:00.000Z` })
    : ok(ms);
}
