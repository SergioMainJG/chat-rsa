import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ReceiptUseCase } from '../../src/backend/messaging/application/messaging.receipt.use-case.ts';
import { Room } from '../../src/backend/messaging/domain/messaging.room.entity.ts';
import {
  ChainIndex,
  EncryptedPayload,
  IdempotencyKey,
  type MessageId,
  RoomName,
} from '../../src/backend/messaging/domain/messaging.value-objects.ts';
import { PostgresMessageRepository } from '../../src/backend/messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresReceiptRepository } from '../../src/backend/messaging/infrastructure/messaging.receipts.postgresql.ts';
import { ForbiddenError } from '../../src/backend/shared/domain/app.error.ts';
import {
  type IsolatedDatabase,
  isolatedDatabase,
  StaleRoomRepository,
} from '../support/messaging.database.test-support.ts';

// BUG-CRITICAL-03: a receipt from a member who left between the membership check and the UPDATE
// must be a 403-style ForbiddenError result, never a raw Error that ends as `internal`.

const NOT_A_MEMBER = 'You are not a member of this room';
let database: IsolatedDatabase;
let rooms: StaleRoomRepository;
let messages: PostgresMessageRepository;
let receipts: PostgresReceiptRepository;

beforeAll(async () => {
  database = await isolatedDatabase(3);
  rooms = new StaleRoomRepository(database.db);
  messages = new PostgresMessageRepository(database.db);
  receipts = new PostgresReceiptRepository(database.db);
});

afterAll(async () => {
  await database.close();
});

async function roomWithMessage(): Promise<{ messageId: MessageId; room: Room }> {
  const { user } = database;
  const draft = Room.draft({
    creator: user(0),
    memberIds: [user(1), user(2)],
    name: RoomName.restore('Team'),
  });
  if (!draft.ok) {
    throw draft.error;
  }
  const room = await rooms.create(draft.value);
  const { message } = await messages.append({
    chainIndex: ChainIndex.restore(0),
    idempotencyKey: IdempotencyKey.restore(crypto.randomUUID()),
    keyEpoch: room.keyEpoch,
    payload: EncryptedPayload.restore({
      authTag: new Uint8Array(16),
      ciphertext: new Uint8Array(3).fill(7),
      iv: new Uint8Array(12),
    }),
    roomId: room.id,
    senderId: user(0),
  });
  return { messageId: message.id, room };
}

describe('receipts after the member left', () => {
  test('PostgresReceiptRepository.advance rejects a non-member with ForbiddenError', async () => {
    const { messageId, room } = await roomWithMessage();
    await rooms.removeMember(room.id, database.user(2));

    let rejection: unknown = null;
    try {
      await receipts.advance(room.id, database.user(2), 'read', messageId);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(new ForbiddenError(NOT_A_MEMBER));
  });

  test('ReceiptUseCase returns a ForbiddenError result when the member left mid-request', async () => {
    const { messageId, room } = await roomWithMessage();
    await rooms.removeMember(room.id, database.user(2));
    rooms.freeze(room);
    const useCase = new ReceiptUseCase(rooms, messages, receipts);

    const result = await useCase.execute(database.user(2), {
      kind: 'read',
      messageId,
      roomId: room.id,
    });

    expect(result).toEqual({ error: new ForbiddenError(NOT_A_MEMBER), ok: false });
    const marks = await receipts.forRoom(room.id);
    expect(marks.has(database.user(2))).toBe(false);
  });

  test('a current member still advances both watermarks with a read', async () => {
    const { messageId, room } = await roomWithMessage();
    const useCase = new ReceiptUseCase(rooms, messages, receipts);

    const result = await useCase.execute(database.user(1), {
      kind: 'read',
      messageId,
      roomId: room.id,
    });

    expect(result).toEqual({
      ok: true,
      value: { delivered: messageId, read: messageId, roomId: room.id, userId: database.user(1) },
    });
  });
});
