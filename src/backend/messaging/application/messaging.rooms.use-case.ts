import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { MemberDirectory, RoomRepository } from '../domain/messaging.repository.ts';

import { type AppError, ValidationError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { MAX_MEMBERS, Room } from '../domain/messaging.room.entity.ts';
import { MemberId, RoomName } from '../domain/messaging.value-objects.ts';
import { Fields, type Input, roomOfMember } from './messaging.access.ts';

export class AddMemberUseCase {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(
    actor: UserId,
    rawRoomId: unknown,
    input: Input,
  ): Promise<Result<RoomSummary, AppError>> {
    const userId = MemberId.create(input.userId, 'userId');
    if (!userId.ok) {
      return err(new ValidationError([userId.error]));
    }
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const allowed = room.value.canAdd(actor, userId.value);
    if (!allowed.ok) {
      return allowed;
    }
    const updated = await this.rooms.addMember(room.value.id, userId.value);
    return ok(updated.toSummary());
  }
}

export class CreateRoomUseCase {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(actor: UserId, input: Input): Promise<Result<RoomSummary, AppError>> {
    const fields = new Fields();
    const name = fields.take(RoomName.create(input.name));
    const memberIds = memberIdsOf(input.memberIds, fields);
    if (name === undefined || memberIds === undefined) {
      return err(fields.error());
    }
    const draft = Room.draft({ creator: actor, memberIds, name });
    if (!draft.ok) {
      return draft;
    }
    const room = await this.rooms.create(draft.value);
    return ok(room.toSummary());
  }
}

export class LeaveRoomUseCase {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(actor: UserId, rawRoomId: unknown): Promise<Result<RoomSummary, AppError>> {
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const allowed = room.value.canLeave(actor);
    if (!allowed.ok) {
      return allowed;
    }
    const updated = await this.rooms.removeMember(room.value.id, actor);
    return ok(updated.toSummary());
  }
}

/** The id and name of every member, for a member of the room only (S2: names after sign-in). */
export class ListRoomMembersUseCase {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly directory: MemberDirectory,
  ) {}

  async execute(actor: UserId, rawRoomId: unknown): Promise<Result<PublicUser[], AppError>> {
    const room = await roomOfMember(this.rooms, rawRoomId, actor);
    if (!room.ok) {
      return room;
    }
    const names = await this.directory.names(room.value.memberIds);
    return ok([...names].map(([id, name]) => ({ id, name })));
  }
}

export class ListRoomsUseCase {
  constructor(private readonly rooms: RoomRepository) {}

  async execute(actor: UserId): Promise<Result<RoomSummary[], AppError>> {
    const rooms = await this.rooms.listForMember(actor);
    return ok(rooms.map((room) => room.toSummary()));
  }
}

function memberIdsOf(raw: unknown, fields: Fields): undefined | UserId[] {
  if (!Array.isArray(raw) || raw.length > MAX_MEMBERS) {
    fields.push({
      field: 'memberIds',
      message: `memberIds must be an array of at most ${MAX_MEMBERS} user ids`,
    });
    return undefined;
  }
  const ids = raw.map((value: unknown, index) =>
    fields.take(MemberId.create(value, `memberIds[${index}]`)),
  );
  return fields.hasErrors() ? undefined : ids.filter((id) => id !== undefined);
}
