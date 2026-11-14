import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { KeyEpoch, RoomId, RoomName } from './messaging.value-objects.ts';

import {
  type AppError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../shared/domain/app.error.ts';
import { err, ok, okVoid, type Result } from '../../shared/domain/result.ts';

/** Room bounds; the database enforces the same range (`rooms_max_members`, `rooms_min_members`). */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 100;

/** A room to create: the creator plus distinct members, 2 to 100 in total. */
export type RoomDraft = {
  readonly createdBy: UserId;
  readonly memberIds: readonly UserId[];
  readonly name: RoomName;
};

type RoomState = {
  readonly createdBy: UserId;
  readonly id: RoomId;
  readonly keyEpoch: KeyEpoch;
  readonly members: readonly UserId[];
  readonly name: RoomName;
};

const NOT_A_MEMBER = 'You are not a member of this room';

export class Room {
  get createdBy(): UserId {
    return this.state.createdBy;
  }

  get id(): RoomId {
    return this.state.id;
  }

  get keyEpoch(): KeyEpoch {
    return this.state.keyEpoch;
  }

  get memberCount(): number {
    return this.members.size;
  }

  get memberIds(): readonly UserId[] {
    return [...this.members];
  }

  get name(): RoomName {
    return this.state.name;
  }

  private readonly members: ReadonlySet<UserId>;

  private constructor(private readonly state: RoomState) {
    this.members = new Set(state.members);
  }

  static draft(input: {
    readonly creator: UserId;
    readonly memberIds: readonly UserId[];
    readonly name: RoomName;
  }): Result<RoomDraft, ValidationError> {
    const memberIds = [...new Set([input.creator, ...input.memberIds])];
    if (memberIds.length < MIN_MEMBERS || memberIds.length > MAX_MEMBERS) {
      return err(
        new ValidationError([
          { field: 'memberIds', message: `A room needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members` },
        ]),
      );
    }
    return ok({ createdBy: input.creator, memberIds, name: input.name });
  }

  static restore(state: RoomState): Room {
    return new Room(state);
  }

  /** Senders must encrypt with the current epoch, so a key a removed member holds is never used. */
  assertCurrentEpoch(epoch: KeyEpoch): Result<void, AppError> {
    if (epoch !== this.keyEpoch) {
      return err(new ConflictError(`Sender key epoch is stale; rotate to epoch ${this.keyEpoch}`));
    }
    return okVoid();
  }

  /** The guard every read, write, and subscription goes through. */
  assertMember(userId: UserId): Result<void, AppError> {
    return this.isMember(userId) ? okVoid() : err(new ForbiddenError(NOT_A_MEMBER));
  }

  canAdd(actor: UserId, candidate: UserId): Result<void, AppError> {
    const guard = this.assertMember(actor);
    if (!guard.ok) {
      return guard;
    }
    if (this.isMember(candidate)) {
      return err(new ConflictError('User is already a member of this room'));
    }
    if (this.memberCount >= MAX_MEMBERS) {
      return err(new ConflictError(`A room holds at most ${MAX_MEMBERS} members`));
    }
    return okVoid();
  }

  canLeave(userId: UserId): Result<void, AppError> {
    const guard = this.assertMember(userId);
    if (!guard.ok) {
      return guard;
    }
    if (this.memberCount <= MIN_MEMBERS) {
      return err(new ConflictError(`A room needs at least ${MIN_MEMBERS} members`));
    }
    return okVoid();
  }

  isMember(userId: UserId): boolean {
    return this.members.has(userId);
  }

  toSummary(): RoomSummary {
    return {
      id: this.id,
      keyEpoch: this.keyEpoch,
      memberIds: this.memberIds,
      name: this.name.value,
    };
  }
}
