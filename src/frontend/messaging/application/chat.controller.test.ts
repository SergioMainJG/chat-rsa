import { describe, expect, test } from 'bun:test';

import type { MessageView, RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { ClientFrame, ServerFrame } from '../../../shared/contracts/messaging.socket.contract.ts';
import type { ConnectionState } from '../connection/messaging.connection.ts';
import type { MessageItem } from '../presentation/chat.view-model.ts';

import { FakeTimers, settle } from '../connection/messaging.connection.test-support.ts';
import { InMemoryOutbox } from '../connection/messaging.outbox.ts';
import { InMemoryLocalMessageStore } from '../search/messaging.search.ts';
import { ChatApi } from './chat.api.ts';
import { ChatController, type ChatView, type SearchResult } from './chat.controller.ts';

const SELF = { id: 1, name: 'alice' };
const ROOM: RoomSummary = { id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' };

class RecordingView implements ChatView {
  messages: readonly MessageItem[] = [];
  readonly notices: string[] = [];
  search: readonly SearchResult[] = [];
  readonly states: ConnectionState[] = [];
  typing = '';

  notify = (text: string): void => {
    this.notices.push(text);
  };

  renderConnection = (state: ConnectionState): void => {
    this.states.push(state);
  };

  renderMessages = (items: readonly MessageItem[]): void => {
    this.messages = items;
  };

  renderRoom = (): void => {
    // The header is not checked here.
  };

  renderRooms = (): void => {
    // The room list is not checked here.
  };

  renderSearch = (results: readonly SearchResult[]): void => {
    this.search = results;
  };

  renderTyping = (text: string): void => {
    this.typing = text;
  };
}

function message(overrides: Partial<MessageView>): MessageView {
  return {
    authTag: 't',
    chainIndex: 0,
    ciphertext: 'hello',
    createdAt: '2026-11-12T10:00:00.000Z',
    id: '019a0000-0000-7000-8000-000000000001',
    idempotencyKey: 'k1',
    iv: 'i',
    keyEpoch: 1,
    roomId: 'r1',
    senderId: 2,
    ...overrides,
  };
}

/** Plays the socket: frames sent while open are recorded; `receive` feeds a server frame. */
class FakeConnection {
  handlers: null | { onFrame: (frame: ServerFrame) => void; onState: (state: ConnectionState) => void } = null;
  open = false;
  readonly sent: ClientFrame[] = [];

  close = (): void => {
    // Nothing to release.
  };

  goOnline(): void {
    this.open = true;
    this.handlers?.onState('open');
    this.receive({ expiresAt: '2099-01-01T00:00:00.000Z', roomIds: ['r1'], type: 'ready', userId: SELF.id });
  }

  isOpen = (): boolean => this.open;

  receive(frame: ServerFrame): void {
    this.handlers?.onFrame(frame);
  }

  send = (frame: ClientFrame): boolean => {
    if (this.open) {
      this.sent.push(frame);
    }
    return this.open;
  };

  start = (): void => {
    // Tests open the connection with goOnline().
  };
}

function setup(options: { visible?: boolean } = {}): {
  connection: FakeConnection;
  controller: ChatController;
  outbox: InMemoryOutbox;
  routes: Record<string, () => Response>;
  store: InMemoryLocalMessageStore;
  view: RecordingView;
} {
  const routes: Record<string, () => Response> = {
    'GET /api/rooms': () => Response.json([ROOM]),
    'GET /api/rooms/r1/keys': () =>
      Response.json([
        { publicKey: 'pk', userId: 1 },
        { publicKey: 'pk2', userId: 2 },
      ]),
    'GET /api/rooms/r1/messages?limit=50': () => Response.json({ messages: [], nextBefore: null }),
    'GET /api/rooms/r1/receipts': () => Response.json([]),
    'GET /api/rooms/r1/sender-keys?keyEpoch=1': () => Response.json([]),
  };
  const api = new ChatApi({
    fetch: async (url, init) => routes[`${init.method ?? 'GET'} ${url}`]?.() ?? new Response(null, { status: 204 }),
    onUnauthorized: () => {
      // Not exercised here; ChatApi tests cover 401s.
    },
  });
  const connection = new FakeConnection();
  const outbox = new InMemoryOutbox();
  const store = new InMemoryLocalMessageStore();
  const view = new RecordingView();
  let uuid = 0;
  const controller = new ChatController({
    api,
    connect: (handlers) => {
      connection.handlers = handlers;
      return connection;
    },
    crypto: {
      // "bad" ciphertext stands for a message whose sender key has not arrived yet.
      decrypt: async (stored, loadEnvelope) => {
        if (stored.ciphertext !== 'bad') {
          return `plain:${stored.ciphertext}`;
        }
        return (await loadEnvelope(stored.roomId, stored.keyEpoch, stored.senderId)) === null ? null : 'late';
      },
      encrypt: async ({ keyEpoch, text }) => ({ authTag: 't', chainIndex: 0, ciphertext: text, iv: 'i', keyEpoch }),
      prepareEpoch: async () => [],
      // Every key is a first sight here; pinning has its own tests (chat.controller.key-change.test.ts).
      trustIdentityKeys: async () => {
        // Nothing is pinned by this double.
      },
      verifyIdentityKeys: async () => [],
    },
    formatTime: (iso) => iso,
    isDocumentVisible: () => options.visible ?? true,
    now: () => 0,
    outbox,
    randomUUID: () => {
      uuid += 1;
      return `key-${uuid}`;
    },
    store,
    timers: new FakeTimers(),
    user: SELF,
    view,
  });
  return { connection, controller, outbox, routes, store, view };
}

describe('ChatController', () => {
  test('a message sent offline shows as pending at once and stays in the outbox', async () => {
    const { controller, outbox, view } = setup();
    await controller.start(null);

    await controller.send('hi');

    expect(view.messages.map((item) => [item.text, item.status])).toEqual([['hi', 'pending']]);
    const queued = await outbox.list();
    expect(queued.map((item) => item.text)).toEqual(['hi']);
  });

  test('once online the queued message is sent, and its ack marks it delivered and indexes it locally', async () => {
    const { connection, controller, outbox, store, view } = setup();
    await controller.start(null);
    await controller.send('hi');

    connection.goOnline();
    await settle();
    const frame = connection.sent.find((sent) => sent.type === 'message.send');
    expect(frame).toMatchObject({ ciphertext: 'hi', idempotencyKey: 'key-1', keyEpoch: 1, roomId: 'r1' });
    expect(view.messages[0]?.status).toBe('sent');

    const stored = message({ id: '019a0000-0000-7000-8000-000000000009', idempotencyKey: 'key-1', senderId: 1 });
    connection.receive({ duplicate: false, idempotencyKey: 'key-1', message: stored, type: 'message.ack' });
    await settle();

    expect(view.messages.map((item) => [item.id, item.status])).toEqual([[stored.id, 'delivered']]);
    expect(await outbox.list()).toEqual([]);
    const found = await store.search('hi');
    expect(found.map((local) => local.id)).toEqual([stored.id]);
  });

  test('message.new is decrypted, shown, indexed locally and acknowledged with a delivered receipt', async () => {
    const { connection, controller, store, view } = setup();
    await controller.start(null);
    connection.goOnline();
    await settle();

    connection.receive({ message: message({}), type: 'message.new' });
    await settle();

    expect(view.messages.map((item) => [item.sender, item.text])).toEqual([['User 2', 'plain:hello']]);
    expect(connection.sent).toContainEqual({
      kind: 'delivered',
      messageId: message({}).id,
      roomId: 'r1',
      type: 'receipt',
    });
    const found = await store.search('plain');
    expect(found).toHaveLength(1);
  });

  test('an undecryptable message says so and is decrypted when its sender keys arrive', async () => {
    const { connection, controller, routes, view } = setup();
    await controller.start(null);

    connection.receive({ message: message({ ciphertext: 'bad' }), type: 'message.new' });
    await settle();
    expect(view.messages.map((item) => [item.text, item.undecryptable])).toEqual([['Unable to decrypt', true]]);

    const envelope = {
      authTag: 't',
      ciphertext: 'c',
      ephemeralPublicKey: 'e',
      iv: 'i',
      keyEpoch: 1,
      recipientId: 1,
      roomId: 'r1',
      senderId: 2,
    };
    routes['GET /api/rooms/r1/sender-keys?keyEpoch=1'] = () => Response.json([envelope]);
    // The cache answers from memory until sender-keys.available makes it fetch the epoch again.
    connection.receive({ keyEpoch: 1, roomId: 'r1', senderId: 2, type: 'sender-keys.available' });
    await settle();

    expect(view.messages.map((item) => [item.text, item.undecryptable])).toEqual([['late', false]]);
  });

  test('a visible message sends one read receipt, only while the page is visible, and never twice', async () => {
    const { connection, controller } = setup();
    await controller.start(null);
    connection.goOnline();
    await settle();
    const { id } = message({});

    controller.messageVisibility(id, true);
    controller.flushReads();
    controller.flushReads();

    expect(connection.sent.filter((frame) => frame.type === 'receipt' && frame.kind === 'read')).toEqual([
      { kind: 'read', messageId: id, roomId: 'r1', type: 'receipt' },
    ]);
  });

  test('no read receipt is sent while the page is hidden', async () => {
    const { connection, controller } = setup({ visible: false });
    await controller.start(null);
    connection.goOnline();
    await settle();

    controller.messageVisibility(message({}).id, true);
    controller.flushReads();

    expect(connection.sent.filter((frame) => frame.type === 'receipt' && frame.kind === 'read')).toEqual([]);
  });

  test('a read receipt from another member marks covered own messages read', async () => {
    const { connection, controller, view } = setup();
    await controller.start(null);
    await controller.send('hi');
    connection.goOnline();
    await settle();
    const stored = message({ id: '019a0000-0000-7000-8000-000000000005', idempotencyKey: 'key-1', senderId: 1 });
    connection.receive({ duplicate: false, idempotencyKey: 'key-1', message: stored, type: 'message.ack' });
    await settle();

    connection.receive({ delivered: null, read: stored.id, roomId: 'r1', type: 'receipt', userId: 2 });

    expect(view.messages[0]?.status).toBe('read');
  });

  test('typing frames from others show who is typing', async () => {
    const { connection, controller, view } = setup();
    await controller.start(null);

    connection.receive({ active: true, roomId: 'r1', type: 'typing', userId: 2 });
    expect(view.typing).toBe('User 2 is typing…');

    connection.receive({ active: false, roomId: 'r1', type: 'typing', userId: 2 });
    expect(view.typing).toBe('');
  });

  test('search runs over the decrypted local store only', async () => {
    const { controller, store, view } = setup();
    await controller.start(null);
    await store.put({
      createdAt: '2026-11-12T10:00:00.000Z',
      id: 'm1',
      roomId: 'r1',
      senderId: 2,
      text: 'lunch at noon',
    });

    await controller.search('lunch');

    expect(view.search.map((result) => [result.roomName, result.text])).toEqual([['general', 'lunch at noon']]);
  });
});
