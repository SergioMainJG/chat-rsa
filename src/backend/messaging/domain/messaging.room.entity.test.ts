import { describe, expect, test } from 'bun:test';

import { ConflictError, ForbiddenError, ValidationError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { MAX_MEMBERS, Room } from './messaging.room.entity.ts';
import { KeyEpoch, RoomId, RoomName } from './messaging.value-objects.ts';

const ID = RoomId.restore('01a1d2f6-0c3b-7f64-aba0-86283af1bcda');
const NAME = RoomName.restore('Team');

function ids(...values: number[]): UserId[] {
  return values.map((value) => UserId.restore(value));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function room(...members: number[]): Room {
  return Room.restore({
    createdBy: UserId.restore(members[0] ?? 1),
    id: ID,
    keyEpoch: KeyEpoch.restore(2),
    members: ids(...members),
    name: NAME,
  });
}

describe('Room.draft', () => {
  test('includes the creator, removes duplicates, and accepts 2 members', () => {
    const result = Room.draft({ creator: UserId.restore(1), memberIds: ids(2, 2, 1), name: NAME });
    expect(result.ok && result.value.memberIds).toEqual(ids(1, 2));
  });

  test('rejects a room with only the creator', () => {
    const result = Room.draft({ creator: UserId.restore(1), memberIds: ids(1), name: NAME });
    expect(result).toEqual({
      error: new ValidationError([{ field: 'memberIds', message: 'A room needs 2 to 100 members' }]),
      ok: false,
    });
  });

  test('accepts 100 members and rejects 101', () => {
    expect(Room.draft({ creator: UserId.restore(1), memberIds: ids(...range(2, 100)), name: NAME }).ok).toBe(true);
    expect(Room.draft({ creator: UserId.restore(1), memberIds: ids(...range(2, 101)), name: NAME }).ok).toBe(false);
  });
});

describe('Room membership guards', () => {
  test('isMember is true only for members', () => {
    const subject = room(1, 2);
    expect(subject.isMember(UserId.restore(2))).toBe(true);
    expect(subject.isMember(UserId.restore(3))).toBe(false);
  });

  test('assertMember rejects a non-member with 403', () => {
    expect(room(1, 2).assertMember(UserId.restore(3))).toEqual({
      error: new ForbiddenError('You are not a member of this room'),
      ok: false,
    });
    expect(room(1, 2).assertMember(UserId.restore(1)).ok).toBe(true);
  });
});

describe('Room.canAdd', () => {
  test('a member can add a new user', () => {
    expect(room(1, 2).canAdd(UserId.restore(1), UserId.restore(3)).ok).toBe(true);
  });

  test('a non-member cannot add anyone', () => {
    expect(room(1, 2).canAdd(UserId.restore(9), UserId.restore(3))).toEqual({
      error: new ForbiddenError('You are not a member of this room'),
      ok: false,
    });
  });

  test('an existing member cannot be added twice', () => {
    expect(room(1, 2).canAdd(UserId.restore(1), UserId.restore(2))).toEqual({
      error: new ConflictError('User is already a member of this room'),
      ok: false,
    });
  });

  test(`a room with ${MAX_MEMBERS} members is full`, () => {
    expect(room(...range(1, 100)).canAdd(UserId.restore(1), UserId.restore(101))).toEqual({
      error: new ConflictError('A room holds at most 100 members'),
      ok: false,
    });
  });
});

describe('Room.canLeave', () => {
  test('a member of a room with 3 members can leave', () => {
    expect(room(1, 2, 3).canLeave(UserId.restore(3)).ok).toBe(true);
  });

  test('the last 2 members cannot leave', () => {
    expect(room(1, 2).canLeave(UserId.restore(2))).toEqual({
      error: new ConflictError('A room needs at least 2 members'),
      ok: false,
    });
  });

  test('a non-member cannot leave', () => {
    expect(room(1, 2, 3).canLeave(UserId.restore(4)).ok).toBe(false);
  });
});

describe('Room.assertCurrentEpoch', () => {
  test('accepts a message encrypted with the current key epoch', () => {
    expect(room(1, 2).assertCurrentEpoch(KeyEpoch.restore(2)).ok).toBe(true);
  });

  test('rejects a stale epoch so a removed member key is never used', () => {
    expect(room(1, 2).assertCurrentEpoch(KeyEpoch.restore(1))).toEqual({
      error: new ConflictError('Sender key epoch is stale; rotate to epoch 2'),
      ok: false,
    });
  });
});
