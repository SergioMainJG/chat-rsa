// Deterministic doubles for ChatController tests: a scripted REST backend, a fake socket and a view
// that records what it was told to draw. Nothing here opens a real socket or touches the network.
import type { MessageView, RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type {
  ClientFrame,
  ServerFrame,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import type { ConnectionState } from '../connection/messaging.connection.ts';
import type { MessageItem, RoomHeader } from '../presentation/chat.view-model.ts';

import { FakeTimers } from '../connection/messaging.connection.test-support.ts';
import { InMemoryOutbox } from '../connection/messaging.outbox.ts';
import { InMemoryKeyStore } from '../crypto/messaging.crypto.key-store.ts';
import { SenderKeySession } from '../crypto/messaging.crypto.session.ts';
import { InMemoryLocalMessageStore } from '../search/messaging.search.ts';
import { ChatApi } from './chat.api.ts';
import {
  ChatController,
  type ChatControllerDeps,
  type ChatView,
  type SearchResult,
} from './chat.controller.ts';

export const SELF = { id: 1, name: 'alice' };

export class RecordingView implements ChatView {
  header: null | RoomHeader = null;
  keyWarnings: readonly string[] = [];
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

  renderKeyWarnings = (warnings: readonly string[]): void => {
    this.keyWarnings = warnings;
  };

  renderMessages = (items: readonly MessageItem[]): void => {
    this.messages = items;
  };

  renderRoom = (header: null | RoomHeader): void => {
    this.header = header;
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

/** Plays the socket: frames sent while open are recorded; `receive` feeds a server frame. */
export type ControllerHarness = {
  readonly connection: FakeConnection;
  readonly controller: ChatController;
  /** This user's key store: identity key pins (S5) are checked against it. */
  readonly keys: InMemoryKeyStore;
  readonly outbox: InMemoryOutbox;
  /** Every REST call, as `METHOD url`, in order. */
  readonly requests: string[];
  readonly routes: Record<string, Route>;
  readonly store: InMemoryLocalMessageStore;
  readonly timers: FakeTimers;
  readonly view: RecordingView;
};

export type Route = (body: unknown) => Response;

export class FakeConnection {
  handlers: null | {
    onFrame: (frame: ServerFrame) => void;
    onState: (state: ConnectionState) => void;
  } = null;
  open = false;
  readonly sent: ClientFrame[] = [];

  close = (): void => {
    this.goOffline();
  };

  goOffline(): void {
    if (this.open) {
      this.open = false;
      this.handlers?.onState('closed');
    }
  }

  goOnline(roomIds: readonly string[] = ['r1']): void {
    this.open = true;
    this.handlers?.onState('open');
    this.receive({
      expiresAt: '2099-01-01T00:00:00.000Z',
      roomIds: [...roomIds],
      type: 'ready',
      userId: SELF.id,
    });
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

  /** The `message.send` frames sent so far. */
  sends(): Array<Extract<ClientFrame, { type: 'message.send' }>> {
    return this.sent.filter((frame) => frame.type === 'message.send');
  }

  start = (): void => {
    // Tests open the connection with goOnline().
  };
}

export function storedMessage(overrides: Partial<MessageView>): MessageView {
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

/**
 * A controller for `SELF` whose REST backend answers from `routes` (keyed `METHOD url`; a missing
 * route answers 204). By default it knows one room `r1` (epoch 1, members 1 and 2) whose members
 * both published identity keys, and a crypto double that encrypts to the plaintext.
 */
export function conflict(ref: string, message: string): ServerFrame {
  return { code: 'conflict', message, ref, type: 'error' };
}

export function controllerHarness(
  options: {
    readonly crypto?: Partial<ChatControllerDeps['crypto']>;
    readonly rooms?: readonly RoomSummary[];
  } = {},
): ControllerHarness {
  const rooms = options.rooms ?? [{ id: 'r1', keyEpoch: 1, memberIds: [1, 2], name: 'general' }];
  const routes: Record<string, Route> = {
    'GET /api/rooms': () => Response.json(rooms),
  };
  for (const room of rooms) {
    routes[`GET /api/rooms/${room.id}/keys`] = () =>
      Response.json(room.memberIds.map((userId) => ({ publicKey: `pk${userId}`, userId })));
    routes[`GET /api/rooms/${room.id}/messages?limit=50`] = () =>
      Response.json({ messages: [], nextBefore: null });
    routes[`GET /api/rooms/${room.id}/receipts`] = () => Response.json([]);
  }
  const requests: string[] = [];
  const api = new ChatApi({
    fetch: async (url, init) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      requests.push(key);
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      return routes[key]?.(body) ?? new Response(null, { status: 204 });
    },
    onUnauthorized: () => {
      // Not exercised here; ChatApi tests cover 401s.
    },
  });
  const connection = new FakeConnection();
  const outbox = new InMemoryOutbox();
  const store = new InMemoryLocalMessageStore();
  const timers = new FakeTimers();
  const view = new RecordingView();
  const keys = new InMemoryKeyStore();
  // Real pinning over the in-memory store; the doubles above stand in for wrapping and encrypting.
  const pinning = new SenderKeySession(keys);
  let uuid = 0;
  const controller = new ChatController({
    api,
    connect: (handlers) => {
      connection.handlers = handlers;
      return connection;
    },
    crypto: {
      decrypt: async (stored) =>
        stored.ciphertext === 'bad' ? null : `plain:${stored.ciphertext}`,
      encrypt: async ({ keyEpoch, text }) => ({
        authTag: 't',
        chainIndex: 0,
        ciphertext: text,
        iv: 'i',
        keyEpoch,
      }),
      prepareEpoch: async () => [],
      trustIdentityKeys: async (input) => pinning.trustIdentityKeys(input),
      verifyIdentityKeys: async (input) => pinning.verifyIdentityKeys(input),
      ...options.crypto,
    },
    formatTime: (iso) => iso,
    isDocumentVisible: () => true,
    now: () => 0,
    outbox,
    randomUUID: () => {
      uuid += 1;
      return `key-${uuid}`;
    },
    store,
    timers,
    user: SELF,
    view,
  });
  return { connection, controller, keys, outbox, requests, routes, store, timers, view };
}
