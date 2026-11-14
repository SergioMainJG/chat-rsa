import type { FieldError } from '../../../shared/contracts/error.contract.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { RoomRepository } from '../domain/messaging.repository.ts';
import type { Room } from '../domain/messaging.room.entity.ts';

import { type AppError, ForbiddenError, ValidationError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { RoomId } from '../domain/messaging.value-objects.ts';

/** Untrusted request body or query: every value is checked by a value object before use. */
export type Input = Readonly<Record<string, unknown>>;

/** Collects field errors so a request reports every invalid field at once. */
export class Fields {
  private readonly errors: FieldError[] = [];

  /** The collected errors; only meaningful after a `take` returned `undefined`. */
  error(): ValidationError {
    return new ValidationError(this.errors);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  push(error: FieldError): void {
    this.errors.push(error);
  }

  take<T>(result: Result<T, FieldError | readonly FieldError[]>): T | undefined {
    if (result.ok) {
      return result.value;
    }
    this.errors.push(...(isList(result.error) ? result.error : [result.error]));
    return undefined;
  }
}

function isList(error: FieldError | readonly FieldError[]): error is readonly FieldError[] {
  return Array.isArray(error);
}

/** True for a field the request left out (`undefined` in JSON, `null` from `URLSearchParams`). */
export function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/**
 * The room, only when the user belongs to it. A missing room answers exactly like a room the user
 * is not in, so room ids cannot be probed.
 */
export async function roomOfMember(
  rooms: RoomRepository,
  rawRoomId: unknown,
  userId: UserId,
): Promise<Result<Room, AppError>> {
  const roomId = RoomId.create(rawRoomId);
  if (!roomId.ok) {
    return err(new ValidationError([roomId.error]));
  }
  const room = await rooms.findById(roomId.value);
  if (!room) {
    return err(new ForbiddenError('You are not a member of this room'));
  }
  const guard = room.assertMember(userId);
  return guard.ok ? ok(room) : guard;
}
