import type { AppError } from '../../shared/domain/app.error.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { ReceiptRepository, RoomRepository } from '../domain/messaging.repository.ts';

import { ok, type Result } from '../../shared/domain/result.ts';
import { roomOfMember } from './messaging.access.ts';

/** One member's watermarks: every message up to `delivered` / `read` has that status for them. */
export type MemberReceipts = {
  readonly delivered: null | string;
  readonly read: null | string;
  readonly userId: number;
};

/** Every member's receipt watermarks, ordered by user id, for a room the actor belongs to. */
export class ListReceiptsUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly receipts: ReceiptRepository,
  ) {}

  async execute(actor: UserId, rawRoomId: unknown): Promise<Result<MemberReceipts[], AppError>> {
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const marks = await this.receipts.forRoom(room.value.id);
    return ok(
      [...marks]
        .map(([userId, { delivered, read }]) => ({ delivered, read, userId }))
        .toSorted((a, b) => a.userId - b.userId),
    );
  }
}
