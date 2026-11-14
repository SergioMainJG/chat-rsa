import { describe, expect, test } from 'bun:test';

import { settle } from '../connection/messaging.connection.test-support.ts';
import { controllerHarness, storedMessage } from './chat.controller.test-support.ts';

// S2 (odd/tasks/sign-out.md): after signing in again the chat must look as it was left, so the
// names of the other members come from the server, not only from lookups typed in this session.

describe('member names', () => {
  test('messages and the member list show the names the server gives for the room members', async () => {
    const harness = controllerHarness();
    harness.routes['GET /api/rooms/r1/members'] = () =>
      Response.json([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);
    await harness.controller.start('r1');
    harness.connection.goOnline(['r1']);
    await settle();

    harness.connection.receive({ message: storedMessage({}), type: 'message.new' });
    await settle();

    expect(harness.requests).toContain('GET /api/rooms/r1/members');
    expect(harness.view.messages.map((item) => item.sender)).toEqual(['bob']);
    expect(harness.view.header?.members.map((member) => member.label)).toEqual(['You', 'bob']);
  });

  test('without an answer from the server the other members keep their placeholder', async () => {
    const harness = controllerHarness();
    harness.routes['GET /api/rooms/r1/members'] = () => Response.json({ message: 'Boom' }, { status: 500 });
    await harness.controller.start('r1');
    harness.connection.goOnline(['r1']);
    await settle();

    harness.connection.receive({ message: storedMessage({}), type: 'message.new' });
    await settle();

    expect(harness.view.messages.map((item) => item.sender)).toEqual(['User 2']);
  });
});

describe('read receipts loaded with the history', () => {
  test('an own message read before this sign-in shows as read, whichever request answers first', async () => {
    const harness = controllerHarness();
    const own = storedMessage({ senderId: 1 });
    harness.routes['GET /api/rooms/r1/messages?limit=50'] = () => Response.json({ messages: [own], nextBefore: null });
    harness.routes['GET /api/rooms/r1/receipts'] = () =>
      Response.json([{ delivered: own.id, read: own.id, userId: 2 }]);

    await harness.controller.start('r1');
    await settle();

    expect(harness.view.messages.map((item) => [item.text, item.status])).toEqual([['plain:hello', 'read']]);
  });
});
