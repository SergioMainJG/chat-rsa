import { beforeEach, describe, expect, test } from 'bun:test';

import { ValidationError } from '../../shared/domain/app.error.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { Message } from '../domain/messaging.message.entity.ts';
import { uuidV7Bound } from '../domain/messaging.value-objects.ts';
import { InMemoryMessageRepository, InMemoryRoomRepository, zeros } from './messaging.fakes.test-support.ts';
import { HistoryUseCase } from './messaging.history.use-case.ts';
import { CreateRoomUseCase } from './messaging.rooms.use-case.ts';
import { SendMessageUseCase } from './messaging.send-message.use-case.ts';

// BUG-HIGH-06: page-size and time-window boundaries of HistoryUseCase.

const ALICE = UserId.restore(1);
const BOB = UserId.restore(2);

let rooms: InMemoryRoomRepository;
let messages: InMemoryMessageRepository;
let history: HistoryUseCase;

beforeEach(() => {
  rooms = new InMemoryRoomRepository();
  messages = new InMemoryMessageRepository();
  history = new HistoryUseCase(rooms, messages);
});

async function pageOf(
  roomId: string,
  query: Record<string, unknown>,
): Promise<{ ids: string[]; nextBefore: null | string }> {
  const result = await history.execute(BOB, roomId, query);
  if (!result.ok) {
    throw result.error;
  }
  return { ids: result.value.messages.map((message) => message.id), nextBefore: result.value.nextBefore };
}

async function seed(count: number): Promise<{ ids: string[]; roomId: string }> {
  const created = await new CreateRoomUseCase(rooms).execute(ALICE, { memberIds: [BOB], name: 'Duo' });
  if (!created.ok) {
    throw created.error;
  }
  const room = created.value;
  const send = new SendMessageUseCase(rooms, messages);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // Sequential on purpose: each message must get a later UUIDv7 than the previous one.
    // eslint-disable-next-line no-await-in-loop
    const sent = await send.execute(ALICE, {
      authTag: zeros(16),
      chainIndex: index,
      ciphertext: 'AQID',
      idempotencyKey: crypto.randomUUID(),
      iv: zeros(12),
      keyEpoch: room.keyEpoch,
      roomId: room.id,
    });
    if (!sent.ok) {
      throw sent.error;
    }
    ids.push(sent.value.message.id);
  }
  return { ids, roomId: room.id };
}

describe('HistoryUseCase page size', () => {
  test('limit=1 returns the newest message and a cursor on it', async () => {
    const { ids, roomId } = await seed(2);
    expect(await pageOf(roomId, { limit: '1' })).toEqual({ ids: [ids[1] ?? ''], nextBefore: ids[1] ?? '' });
  });

  test('limit=3 puts the cursor on the last (oldest) message of the page', async () => {
    const { ids, roomId } = await seed(5);
    expect(await pageOf(roomId, { limit: '3' })).toEqual({
      ids: [ids[4] ?? '', ids[3] ?? '', ids[2] ?? ''],
      nextBefore: ids[2] ?? '',
    });
  });

  test('a page exactly as long as limit has no cursor', async () => {
    const { ids, roomId } = await seed(3);
    expect(await pageOf(roomId, { limit: '3' })).toEqual({
      ids: [ids[2] ?? '', ids[1] ?? '', ids[0] ?? ''],
      nextBefore: null,
    });
  });

  test('limit=100 is accepted and returns everything with no cursor', async () => {
    const { ids, roomId } = await seed(3);
    expect(await pageOf(roomId, { limit: '100' })).toEqual({ ids: ids.toReversed(), nextBefore: null });
  });

  test.each(['0', '101'])('limit=%s is rejected', async (limit) => {
    const { roomId } = await seed(1);
    expect(await history.execute(BOB, roomId, { limit })).toEqual({
      error: new ValidationError([{ field: 'limit', message: 'limit must be an integer from 1 to 100' }]),
      ok: false,
    });
  });
});

describe('HistoryUseCase time window', () => {
  test('since=1970-01-01T00:00:00.000Z includes a message stored at millisecond 0', async () => {
    const { ids, roomId } = await seed(1);
    const [stored] = messages.messages;
    if (!stored) {
      throw new Error('no seeded message');
    }
    const atZero = new Message(uuidV7Bound(0, 'min'), new Date(0), stored.draft);
    messages.messages.push(atZero);

    const page = await pageOf(roomId, { since: '1970-01-01T00:00:00.000Z' });

    expect(page.ids).toEqual([ids[0] ?? '', atZero.id]);
  });

  test.each(['since', 'until'])('a %s before 1970 is rejected instead of clamped', async (field) => {
    const { roomId } = await seed(1);
    expect(await history.execute(BOB, roomId, { [field]: '1960-01-01T00:00:00.000Z' })).toEqual({
      error: new ValidationError([{ field, message: `${field} must not be before 1970-01-01T00:00:00.000Z` }]),
      ok: false,
    });
  });

  test('an inverted window (since after until) is rejected', async () => {
    const { roomId } = await seed(1);
    expect(
      await history.execute(BOB, roomId, { since: '2026-11-12T10:00:00.000Z', until: '2026-11-12T09:00:00.000Z' }),
    ).toEqual({
      error: new ValidationError([{ field: 'since', message: 'since must not be after until' }]),
      ok: false,
    });
  });
});
