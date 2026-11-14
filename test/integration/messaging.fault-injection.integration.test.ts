import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  RoomName,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import { PostgresMessageRepository } from '../../src/backend/messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresRoomRepository } from '../../src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts';
import { AppError } from '../../src/backend/shared/domain/app.error.ts';
import { type IsolatedDatabase, isolatedDatabase } from '../support/messaging.database.test-support.ts';

// BUG-MEDIUM-10: only the SQLSTATE + constraint pairs the adapters know may become domain errors.
// Any other database failure (deadlock, lost connection, a check on another constraint) must keep
// its PostgresError so the HTTP layer answers 500 instead of a misleading 400 or 409.

let database: IsolatedDatabase;
let rooms: PostgresRoomRepository;
let messages: PostgresMessageRepository;

beforeAll(async () => {
  database = await isolatedDatabase(4);
  const { db } = database;
  // Raises a real error with the SQLSTATE and constraint the session asks for; inert otherwise.
  // `aaa_` sorts first, so it fires before the schema's own BEFORE triggers.
  await db.unsafe(`
    CREATE FUNCTION inject_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF coalesce(current_setting('fault.code', true), '') <> '' THEN
        RAISE EXCEPTION 'injected fault'
          USING ERRCODE = current_setting('fault.code'),
                CONSTRAINT = coalesce(current_setting('fault.target', true), '');
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER aaa_inject_fault BEFORE INSERT OR DELETE ON room_members
      FOR EACH ROW EXECUTE FUNCTION inject_fault();
    CREATE TRIGGER aaa_inject_fault BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION inject_fault();
  `);
  rooms = new PostgresRoomRepository(db);
  messages = new PostgresMessageRepository(db);
});

afterEach(async () => {
  await database.db.unsafe(`RESET fault.code; RESET fault.target`);
});

afterAll(async () => {
  await database.close();
});

function expectRawDatabaseError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(SQL.PostgresError);
  expect(error).not.toBeInstanceOf(AppError);
  expect(error).toMatchObject({ errno: code });
}

async function failureOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error('expected the operation to fail');
    },
    (error: unknown) => error,
  );
}

async function inject(code: string, constraint = ''): Promise<void> {
  await database.db.unsafe(`SET fault.code = '${code}'; SET fault.target = '${constraint}'`);
}

async function threeMemberRoom(): Promise<Room> {
  const { user } = database;
  const draft = Room.draft({ creator: user(0), memberIds: [user(1), user(2)], name: RoomName.restore('Team') });
  if (!draft.ok) {
    throw draft.error;
  }
  return rooms.create(draft.value);
}

const UNMAPPED = [
  ['40P01', '', 'a deadlock'],
  ['57P01', '', 'an admin shutdown'],
  ['23514', 'some_other_check', 'a check violation on another constraint'],
  ['23505', 'some_other_unique', 'a unique violation on another constraint'],
] as const;

/** Each mapped constraint name raised with another SQLSTATE: the pair, not the name, is the rule. */
const CROSSED = [
  ['23505', 'rooms_max_members', 'a unique code that names the max-members check'],
  ['23505', 'rooms_min_members', 'a unique code that names the min-members check'],
  ['23514', 'room_members_pkey', 'a check code that names the members primary key'],
] as const;

describe('PostgresRoomRepository keeps unmapped database errors', () => {
  test.each(UNMAPPED)('create() rethrows %s (%s)', async (code, constraint) => {
    const { user } = database;
    await inject(code, constraint);
    const draft = Room.draft({ creator: user(0), memberIds: [user(1)], name: RoomName.restore('Team') });
    if (!draft.ok) {
      throw draft.error;
    }
    expectRawDatabaseError(await failureOf(rooms.create(draft.value)), code);
  });

  test.each([...UNMAPPED, ...CROSSED])('addMember() rethrows %s (%s)', async (code, constraint) => {
    const room = await threeMemberRoom();
    await inject(code, constraint);
    expectRawDatabaseError(await failureOf(rooms.addMember(room.id, database.user(3))), code);
  });

  test.each([...UNMAPPED, ...CROSSED])('removeMember() rethrows %s (%s)', async (code, constraint) => {
    const room = await threeMemberRoom();
    await inject(code, constraint);
    expectRawDatabaseError(await failureOf(rooms.removeMember(room.id, database.user(2))), code);
  });

  test('a generic error that is not a PostgresError is rethrown untouched', async () => {
    // A connection whose transactions fail before reaching PostgreSQL.
    const lost = new Proxy(database.db, {
      get: (target, key, receiver): unknown =>
        key === 'begin'
          ? async () => {
              throw new TypeError('connection lost');
            }
          : Reflect.get(target, key, receiver),
    });
    const broken = new PostgresRoomRepository(lost);
    const { user } = database;
    const draft = Room.draft({ creator: user(0), memberIds: [user(1)], name: RoomName.restore('Team') });
    if (!draft.ok) {
      throw draft.error;
    }
    expect(await failureOf(broken.create(draft.value))).toEqual(new TypeError('connection lost'));
  });
});

describe('PostgresMessageRepository.append keeps unmapped database errors', () => {
  test.each([
    ...UNMAPPED,
    ['23514', 'messages_chain_uq', 'a non-unique code that names the chain constraint'],
    ['23505', 'messages_current_key_epoch', 'a unique code that names the epoch constraint'],
    ['42502', '', 'a neighbour of the membership SQLSTATE'],
  ])('rethrows %s (%s)', async (code, constraint) => {
    const room = await threeMemberRoom();
    await inject(code, constraint);
    const pending = messages.append({
      chainIndex: ChainIndex.restore(0),
      idempotencyKey: IdempotencyKey.restore(crypto.randomUUID()),
      keyEpoch: room.keyEpoch,
      payload: EncryptedPayload.restore({
        authTag: new Uint8Array(16),
        ciphertext: new Uint8Array(3).fill(7),
        iv: new Uint8Array(12),
      }),
      roomId: room.id,
      senderId: database.user(0),
    });
    expectRawDatabaseError(await failureOf(pending), code);
  });
});
