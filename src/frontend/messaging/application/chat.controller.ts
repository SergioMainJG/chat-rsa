/**
 * The chat page without the DOM: it owns the page state, reacts to socket frames, and tells a
 * `ChatView` what to draw. Real-time traffic (messages, typing, presence, receipts) goes over the
 * socket and history, rooms and keys over REST (S1).
 */
import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { MessageView, RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type {
  ClientFrame,
  ServerFrame,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import type { ConnectionState, Timers } from '../connection/messaging.connection.ts';
import type { Outbox, OutboxItem } from '../connection/messaging.outbox.ts';
import type { SenderKeySession } from '../crypto/messaging.crypto.session.ts';
import type { LocalMessageStore } from '../search/messaging.search.ts';
import type { ChatApi } from './chat.api.ts';

import {
  type LocalMessageStatus,
  readReceiptCovers,
} from '../connection/messaging.message-status.ts';
import {
  type FlushStop,
  OutboxFlusher,
  type SendFrame,
} from '../connection/messaging.outbox-flusher.ts';
import { HistoryCursor } from '../presentation/chat.history.ts';
import { ReadReceiptTracker } from '../presentation/chat.read-receipts.ts';
import { mergeStatus } from '../presentation/chat.status.ts';
import {
  TYPING_IDLE_MS,
  TYPING_INTERVAL_MS,
  TYPING_TTL_MS,
  typingLabel,
  TypingRoster,
  TypingThrottle,
} from '../presentation/chat.typing.ts';
import {
  displayName,
  type MessageEntry,
  type MessageItem,
  parseMemberNames,
  type RoomHeader,
  type RoomItem,
  toMessageItems,
  toRoomHeader,
  toRoomItems,
} from '../presentation/chat.view-model.ts';
import { EnvelopeCache, EnvelopeRetryQueue, EpochKeeper } from './chat.epochs.ts';

export type ChatControllerDeps = {
  readonly api: ChatApi;
  /** Opens the socket connection, reporting its frames and states to the controller. */
  readonly connect: (handlers: {
    readonly onFrame: (frame: ServerFrame) => void;
    readonly onState: (state: ConnectionState) => void;
  }) => ConnectionPort;
  readonly crypto: Pick<SenderKeySession, 'decrypt' | 'encrypt' | 'prepareEpoch'>;
  readonly formatTime: (iso: string) => string;
  /** `document.visibilityState === 'visible'`: read receipts wait while the tab is hidden. */
  readonly isDocumentVisible: () => boolean;
  readonly now: () => number;
  readonly outbox: Outbox;
  readonly randomUUID: () => string;
  readonly store: LocalMessageStore;
  readonly timers: Timers;
  readonly user: PublicUser;
  readonly view: ChatView;
};

/** What the page draws; every method replaces what it drew before. */
export type ChatView = {
  readonly notify: (message: string) => void;
  readonly renderConnection: (state: ConnectionState) => void;
  readonly renderMessages: (items: readonly MessageItem[], hasOlder: boolean) => void;
  readonly renderRoom: (header: null | RoomHeader) => void;
  readonly renderRooms: (rooms: readonly RoomItem[]) => void;
  readonly renderSearch: (results: readonly SearchResult[], query: string) => void;
  readonly renderTyping: (text: string) => void;
};

/** The part of `SocketConnection` the controller uses. */
export type ConnectionPort = {
  readonly close: () => void;
  readonly isOpen: () => boolean;
  readonly send: (frame: ClientFrame) => boolean;
  readonly start: () => void;
};

export type SearchResult = {
  readonly id: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly sender: string;
  readonly text: string;
  readonly timeLabel: string;
};

export const ACK_TIMEOUT_MS = 10_000;
export const HISTORY_PAGE_SIZE = 50;
/** After a transient flush stop (timeout, rate limit, keys not ready), the outbox retries this soon. */
export const FLUSH_RETRY_MS = 5000;

/** A refusal that a retry cannot fix: the message is dropped from the outbox and marked failed. */
const PERMANENT_ERRORS = new Set(['bad_frame', 'forbidden', 'not_found', 'validation']);
/** A `conflict` that re-encrypting cannot fix: the key already names another stored message. */
const REUSED_KEY = 'idempotencyKey was already used for another message';
/**
 * Flush stops caused by `conflict` (each after one refreshed retry) before the message is given up:
 * a stale epoch is fixed by the refresh and chain index drift by the next index, so a conflict that
 * keeps coming back would otherwise retry every FLUSH_RETRY_MS forever.
 */
export const MAX_CONFLICT_STOPS = 3;

export class ChatController {
  get activeRoomId(): null | string {
    return this.#activeRoomId;
  }

  #activeRoomId: null | string = null;
  readonly #connection: ConnectionPort;
  /** Consecutive `conflict` flush stops per idempotency key. */
  readonly #conflicts = new Map<string, number>();
  readonly #cursors = new Map<string, HistoryCursor>();
  readonly #deps: ChatControllerDeps;
  readonly #entries = new Map<string, Map<string, MessageEntry>>();
  readonly #envelopes: EnvelopeCache;
  readonly #flusher: OutboxFlusher;
  /** Rooms whose first history page was requested since the page loaded. */
  readonly #historyRequested = new Set<string>();
  readonly #keeper: EpochKeeper;
  /** Plaintext of messages this browser decrypted before, by room, from the local store. */
  readonly #localTexts = new Map<string, Promise<ReadonlyMap<string, string>>>();
  readonly #names = new Map<number, string>();
  /**
   * The latest read receipt of every other member, by room. Kept so a message that arrives after
   * its receipt (history and receipts load in parallel) still shows as read.
   */
  readonly #readers = new Map<string, Map<number, Extract<ServerFrame, { type: 'receipt' }>>>();
  /** Rooms whose member names are being fetched, so one change asks once. */
  readonly #namesLoading = new Set<string>();
  readonly #online = new Map<string, Set<number>>();
  /** Room of every message queued in the outbox, by idempotency key. */
  readonly #queuedRooms = new Map<string, string>();
  #queuedSeq = 0;
  readonly #reads = new ReadReceiptTracker();
  #retryTimer: null | number = null;
  readonly #rooms = new Map<string, RoomSummary>();
  readonly #roster = new TypingRoster();
  readonly #selfId: number;
  #state: ConnectionState = 'closed';
  readonly #statuses = new Map<string, LocalMessageStatus>();
  readonly #throttle: TypingThrottle;
  #typingTimer: null | number = null;
  /** Messages that could not be decrypted yet, retried when new sender keys arrive. */
  readonly #undecrypted = new Map<string, MessageView>();

  constructor(deps: ChatControllerDeps) {
    this.#deps = deps;
    const { api, crypto, timers, user } = deps;
    this.#selfId = user.id;
    this.#names.set(user.id, user.name);
    this.#envelopes = new EnvelopeCache(async (roomId, keyEpoch) =>
      api.senderKeys(roomId, keyEpoch),
    );
    this.#keeper = new EpochKeeper({
      api: {
        roomKeys: async (roomId) => api.roomKeys(roomId),
        uploadSenderKeys: async (roomId, keyEpoch, envelopes) =>
          api.uploadSenderKeys(roomId, keyEpoch, envelopes),
      },
      crypto,
      queue: new EnvelopeRetryQueue(),
      selfId: user.id,
    });
    this.#connection = deps.connect({
      onFrame: (frame) => {
        this.#onFrame(frame);
      },
      onState: (state) => {
        this.#onState(state);
      },
    });
    this.#flusher = new OutboxFlusher({
      ackTimeoutMs: ACK_TIMEOUT_MS,
      connection: this.#connection,
      encrypt: async (item) => this.#encrypt(item),
      now: deps.now,
      onStatus: (key, status) => {
        this.#setStatus(key, status);
      },
      onStop: (stop) => {
        void this.#onFlushStop(stop);
      },
      outbox: deps.outbox,
      randomUUID: deps.randomUUID,
      refresh: async () => this.#reloadRooms(),
      timers,
    });
    this.#throttle = new TypingThrottle({
      idleMs: TYPING_IDLE_MS,
      intervalMs: TYPING_INTERVAL_MS,
      now: deps.now,
      send: (roomId, active) => {
        this.#connection.send({ active, roomId, type: 'typing' });
      },
      timers,
    });
  }

  /** Adds a member to the open room by name. Returns an error message, or null on success. */
  async addMember(name: string): Promise<null | string> {
    const roomId = this.#activeRoomId;
    if (roomId === null) {
      return 'Open a room first.';
    }
    const user = await this.#deps.api.findUser(name.trim());
    if (user.kind !== 'ok') {
      return user.kind === 'not-found' ? `No user named "${name.trim()}".` : messageOf(user);
    }
    this.#names.set(user.value.id, user.value.name);
    const added = await this.#deps.api.addMember(roomId, user.value.id);
    if (added.kind !== 'ok') {
      return messageOf(added);
    }
    this.#upsertRoom(added.value);
    return null;
  }

  /** The user typed in the composer: throttled `typing` frames. */
  composerInput(): void {
    if (this.#activeRoomId !== null) {
      this.#throttle.input(this.#activeRoomId);
    }
  }

  /**
   * Creates a room with the named members (the creator is added by the server). Returns an error
   * message, or null on success.
   */
  async createRoom(name: string, memberNames: string): Promise<null | string> {
    const self = this.#deps.user.name;
    const names = parseMemberNames(memberNames).filter((member) => member !== self);
    if (names.length === 0) {
      return 'Add at least one other member.';
    }
    const lookups = await Promise.all(names.map(async (member) => this.#deps.api.findUser(member)));
    const ids: number[] = [];
    for (const [index, lookup] of lookups.entries()) {
      if (lookup.kind !== 'ok') {
        return lookup.kind === 'not-found'
          ? `No user named "${names[index] ?? ''}".`
          : messageOf(lookup);
      }
      this.#names.set(lookup.value.id, lookup.value.name);
      ids.push(lookup.value.id);
    }
    const created = await this.#deps.api.createRoom(name.trim(), ids);
    if (created.kind !== 'ok') {
      return messageOf(created);
    }
    this.#upsertRoom(created.value);
    this.#connection.send({ roomId: created.value.id, type: 'room.subscribe' });
    await this.openRoom(created.value.id);
    return null;
  }

  /** Sends one read receipt for the newest visible message of the open room, if it is new (S7). */
  flushReads(): void {
    const roomId = this.#activeRoomId;
    if (roomId === null || !this.#deps.isDocumentVisible() || !this.#connection.isOpen()) {
      return;
    }
    const messageId = this.#reads.take(roomId);
    if (messageId !== null) {
      this.#connection.send({ kind: 'read', messageId, roomId, type: 'receipt' });
    }
  }

  /** Leaves the open room. Returns an error message, or null on success. */
  async leaveRoom(): Promise<null | string> {
    const roomId = this.#activeRoomId;
    if (roomId === null) {
      return 'Open a room first.';
    }
    const left = await this.#deps.api.leaveRoom(roomId);
    if (left.kind !== 'ok') {
      return messageOf(left);
    }
    await this.#forgetRoom(roomId);
    this.#activeRoomId = null;
    const [next] = toRoomItems(this.#rooms.values(), null);
    if (next) {
      await this.openRoom(next.id);
    } else {
      this.#renderAll();
    }
    return null;
  }

  /** Loads the next older page of the open room's history over REST. */
  async loadOlder(): Promise<void> {
    const roomId = this.#activeRoomId;
    if (roomId === null) {
      return;
    }
    const cursor = this.#cursorOf(roomId);
    const request = cursor.begin();
    if (request === null) {
      return;
    }
    const page = await this.#deps.api.history(roomId, { ...request, limit: HISTORY_PAGE_SIZE });
    if (page.kind !== 'ok') {
      cursor.fail();
      this.#notifyFailure(page);
      return;
    }
    await Promise.all(page.value.messages.map(async (message) => this.#receive(message)));
    cursor.apply(page.value);
    // Pages are newest first: the first other-member message is the newest one delivered here.
    const newestOther = page.value.messages.find((message) => message.senderId !== this.#selfId);
    if (request.before === undefined && newestOther) {
      this.#connection.send({
        kind: 'delivered',
        messageId: newestOther.id,
        roomId,
        type: 'receipt',
      });
    }
    this.#renderMessages(roomId);
  }

  /** The page's IntersectionObserver reports an other-member message entering or leaving view. */
  messageVisibility(messageId: string, visible: boolean): void {
    const roomId = this.#activeRoomId;
    if (roomId === null) {
      return;
    }
    if (visible) {
      this.#reads.show(roomId, messageId);
    } else {
      this.#reads.hide(roomId, messageId);
    }
  }

  async openRoom(roomId: string): Promise<void> {
    if (!this.#rooms.has(roomId) || this.#activeRoomId === roomId) {
      return;
    }
    this.#throttle.stop();
    this.#activeRoomId = roomId;
    this.#renderAll();
    const room = this.#rooms.get(roomId);
    const work: Array<Promise<unknown>> = [this.#loadReceipts(roomId)];
    if (room) {
      work.push(this.#keeper.ensureEpoch(room.id, room.keyEpoch, room.memberIds));
    }
    if (!this.#historyRequested.has(roomId)) {
      this.#historyRequested.add(roomId);
      work.push(this.loadOlder());
    }
    await Promise.all(work);
  }

  /** Searches the decrypted local store only; the server never sees the query (S15). */
  async search(query: string): Promise<void> {
    if (query.trim() === '') {
      this.#deps.view.renderSearch([], query);
      return;
    }
    const matches = await this.#deps.store.search(query).catch(() => []);
    this.#deps.view.renderSearch(
      matches.map((message) => ({
        id: message.id,
        roomId: message.roomId,
        roomName: this.#rooms.get(message.roomId)?.name ?? 'Unknown room',
        sender: displayName(message.senderId, this.#selfId, this.#names),
        text: message.text,
        timeLabel: this.#deps.formatTime(message.createdAt),
      })),
      query,
    );
  }

  /** Queues a message in the open room; it shows as `pending` at once, online or offline (S9). */
  async send(text: string): Promise<void> {
    const roomId = this.#activeRoomId;
    if (roomId === null || text.trim() === '') {
      return;
    }
    this.#throttle.stop();
    const item = await this.#flusher.enqueue(roomId, text);
    this.#addQueued(item);
    this.#renderMessages(roomId);
  }

  /** Lists rooms, shows messages still queued from earlier visits, and opens the socket. */
  async start(initialRoomId: null | string): Promise<void> {
    this.#deps.view.renderConnection('connecting');
    const [rooms, queued] = await Promise.all([
      this.#deps.api.listRooms(),
      this.#deps.outbox.list().catch((): readonly OutboxItem[] => []),
    ]);
    if (rooms.kind === 'ok') {
      for (const room of rooms.value) {
        this.#rooms.set(room.id, room);
      }
    } else {
      this.#notifyFailure(rooms);
    }
    for (const item of queued) {
      this.#addQueued(item);
      this.#setStatus(item.idempotencyKey, 'pending');
    }
    this.#connection.start();
    const first = toRoomItems(this.#rooms.values(), null)[0]?.id ?? null;
    const target = initialRoomId !== null && this.#rooms.has(initialRoomId) ? initialRoomId : first;
    if (target === null) {
      this.#renderAll();
      return;
    }
    await this.openRoom(target);
  }

  /** Stops typing and closes the socket for good. */
  stop(): void {
    this.#throttle.stop();
    this.#connection.close();
  }

  #addQueued(item: OutboxItem): void {
    this.#queuedSeq += 1;
    this.#queuedRooms.set(item.idempotencyKey, item.roomId);
    this.#roomEntries(item.roomId).set(item.idempotencyKey, {
      createdAt: item.queuedAt,
      failed: false,
      id: null,
      idempotencyKey: item.idempotencyKey,
      queuedOrder: this.#queuedSeq,
      roomId: item.roomId,
      senderId: this.#selfId,
      text: item.text,
    });
  }

  #cursorOf(roomId: string): HistoryCursor {
    let cursor = this.#cursors.get(roomId);
    if (!cursor) {
      cursor = new HistoryCursor();
      this.#cursors.set(roomId, cursor);
    }
    return cursor;
  }

  async #decrypt(message: MessageView): Promise<null | string> {
    const text = await this.#deps.crypto.decrypt(message, this.#envelopes.load);
    if (text !== null) {
      return text;
    }
    const local = await this.#localTextsOf(message.roomId);
    return local.get(message.id) ?? null;
  }

  /**
   * The flusher's encrypt step: makes sure this user's chain key for the room's current epoch
   * reached the members (retrying a failed envelope upload first), then encrypts. An encrypt that
   * finds no chain key prepares the epoch again and retries once.
   */
  async #encrypt(item: OutboxItem): Promise<SendFrame> {
    const room = this.#rooms.get(item.roomId);
    if (!room) {
      throw new Error(`Unknown room ${item.roomId}`);
    }
    const input = {
      idempotencyKey: item.idempotencyKey,
      keyEpoch: room.keyEpoch,
      roomId: room.id,
      selfId: this.#selfId,
      text: item.text,
    };
    await this.#requireEpoch(room);
    let fields: Awaited<ReturnType<SenderKeySession['encrypt']>>;
    try {
      fields = await this.#deps.crypto.encrypt(input);
    } catch {
      this.#keeper.forget(room.id, room.keyEpoch);
      await this.#requireEpoch(room);
      fields = await this.#deps.crypto.encrypt(input);
    }
    return {
      ...fields,
      idempotencyKey: item.idempotencyKey,
      roomId: room.id,
      type: 'message.send',
    };
  }

  /**
   * Drops everything kept for a room the user left (S11): its queued messages (so the outbox never
   * reports them as not sent), cached plaintext, presence and messages waiting for sender keys.
   */
  async #forgetRoom(roomId: string): Promise<void> {
    this.#rooms.delete(roomId);
    this.#entries.delete(roomId);
    this.#cursors.delete(roomId);
    this.#historyRequested.delete(roomId);
    this.#localTexts.delete(roomId);
    this.#online.delete(roomId);
    this.#readers.delete(roomId);
    for (const [id, message] of this.#undecrypted) {
      if (message.roomId === roomId) {
        this.#undecrypted.delete(id);
      }
    }
    const queued = [...this.#queuedRooms].filter(([, queuedRoom]) => queuedRoom === roomId);
    for (const [key] of queued) {
      this.#queuedRooms.delete(key);
      this.#conflicts.delete(key);
      this.#statuses.delete(key);
    }
    const items = await this.#deps.outbox.list().catch((): readonly OutboxItem[] => []);
    await Promise.all(
      items
        .filter((item) => item.roomId === roomId)
        .map(async (item) => this.#deps.outbox.remove(item.idempotencyKey).catch(() => null)),
    );
  }

  /**
   * Whether a flush stop gives the message up. It also counts consecutive `conflict` stops per key:
   * one that keeps coming back after MAX_CONFLICT_STOPS refreshed retries is given up (S5).
   */
  #isPermanent(stop: FlushStop, roomId: string | undefined): boolean {
    const key = stop.idempotencyKey;
    if (stop.reason !== 'rejected') {
      this.#conflicts.delete(key);
      return stop.reason === 'encrypt-failed' && (roomId === undefined || !this.#rooms.has(roomId));
    }
    if (stop.error.code !== 'conflict') {
      this.#conflicts.delete(key);
      return PERMANENT_ERRORS.has(stop.error.code);
    }
    const conflicts = (this.#conflicts.get(key) ?? 0) + 1;
    this.#conflicts.set(key, conflicts);
    return stop.error.message === REUSED_KEY || conflicts >= MAX_CONFLICT_STOPS;
  }

  async #loadReceipts(roomId: string): Promise<void> {
    const receipts = await this.#deps.api.receipts(roomId);
    if (receipts.kind !== 'ok') {
      return;
    }
    for (const receipt of receipts.value) {
      this.#onReceipt({ ...receipt, roomId, type: 'receipt' });
    }
  }

  async #localTextsOf(roomId: string): Promise<ReadonlyMap<string, string>> {
    let texts = this.#localTexts.get(roomId);
    if (!texts) {
      texts = this.#deps.store
        .listByRoom(roomId)
        .then((messages) => new Map(messages.map((message) => [message.id, message.text])))
        .catch(() => new Map<string, string>());
      this.#localTexts.set(roomId, texts);
    }
    return texts;
  }

  #notifyFailure(outcome: { readonly kind: string; readonly message?: string }): void {
    if (outcome.kind !== 'unauthorized') {
      this.#deps.view.notify(messageOf(outcome));
    }
  }

  #onAck(message: MessageView): void {
    const entries = this.#roomEntries(message.roomId);
    const queued = entries.get(message.idempotencyKey);
    this.#queuedRooms.delete(message.idempotencyKey);
    this.#conflicts.delete(message.idempotencyKey);
    if (queued?.text === undefined || queued.text === null) {
      // Not queued in this tab (or no plaintext kept): decrypt the stored copy instead.
      void this.#receive(message).then(() => {
        this.#renderMessages(message.roomId);
        return null;
      });
      return;
    }
    entries.set(message.idempotencyKey, toEntry(message, queued.text));
    this.#setStatus(message.idempotencyKey, 'delivered');
    this.#remember(message, queued.text);
  }

  async #onFlushStop(stop: FlushStop): Promise<void> {
    const key = stop.idempotencyKey;
    const roomId = this.#queuedRooms.get(key);
    if (stop.reason === 'disconnected') {
      return;
    }
    if (roomId === undefined && (await this.#deps.outbox.get(key).catch(() => null)) === null) {
      // Purged when the user left its room: nothing to report, the rest of the outbox goes on.
      this.#conflicts.delete(key);
      this.#flusher.onReady();
      return;
    }
    if (!this.#isPermanent(stop, roomId)) {
      this.#scheduleFlushRetry();
      return;
    }
    this.#conflicts.delete(key);
    await this.#deps.outbox.remove(key);
    this.#queuedRooms.delete(key);
    if (roomId !== undefined) {
      const entry = this.#roomEntries(roomId).get(key);
      if (entry) {
        this.#roomEntries(roomId).set(key, { ...entry, failed: true });
      }
      this.#renderMessages(roomId);
    }
    const reason =
      stop.reason === 'rejected' ? stop.error.message : 'The room is no longer available.';
    this.#deps.view.notify(`A message was not sent: ${reason}`);
    this.#flusher.onReady();
  }

  #onFrame(frame: ServerFrame): void {
    this.#flusher.handleFrame(frame);
    switch (frame.type) {
      case 'auth.refreshed': {
        break;
      }
      case 'error': {
        if (frame.ref === null || !this.#statuses.has(frame.ref)) {
          this.#deps.view.notify(frame.message);
        }
        break;
      }
      case 'message.ack': {
        this.#onAck(frame.message);
        this.#renderMessages(frame.message.roomId);
        break;
      }
      case 'message.new': {
        void this.#onNewMessage(frame.message);
        break;
      }
      case 'presence': {
        this.#onPresence(frame.roomId, frame.userId, frame.online);
        break;
      }
      case 'presence.snapshot': {
        this.#online.set(frame.roomId, new Set(frame.online));
        this.#renderHeader();
        break;
      }
      case 'ready': {
        void this.#onReady();
        break;
      }
      case 'receipt': {
        this.#onReceipt(frame);
        this.#renderMessages(frame.roomId);
        break;
      }
      case 'room.rotated': {
        void this.#onRotated(frame.roomId, frame.keyEpoch);
        break;
      }
      case 'sender-keys.available': {
        void this.#onSenderKeys(frame.roomId, frame.keyEpoch);
        break;
      }
      case 'typing': {
        this.#onTyping(frame.roomId, frame.userId, frame.active);
        break;
      }
      default: {
        break;
      }
    }
  }

  async #onNewMessage(message: MessageView): Promise<void> {
    const own = message.senderId === this.#selfId;
    if (own && this.#roomEntries(message.roomId).has(message.idempotencyKey)) {
      this.#onAck(message);
    } else {
      await this.#receive(message);
      if (!own) {
        this.#connection.send({
          kind: 'delivered',
          messageId: message.id,
          roomId: message.roomId,
          type: 'receipt',
        });
      }
    }
    this.#renderMessages(message.roomId);
  }

  #onPresence(roomId: string, userId: number, online: boolean): void {
    const room = this.#online.get(roomId) ?? new Set<number>();
    if (online) {
      room.add(userId);
    } else {
      room.delete(userId);
    }
    this.#online.set(roomId, room);
    this.#renderHeader();
  }

  /**
   * A new connection: room epochs and members may have changed while offline (a missed
   * `room.rotated`), so the rooms are always reloaded before the epochs are checked (S5).
   */
  async #onReady(): Promise<void> {
    await this.#reloadRooms();
    await Promise.all(
      [...this.#rooms.values()].map(async (room) =>
        this.#keeper.ensureEpoch(room.id, room.keyEpoch, room.memberIds),
      ),
    );
    this.flushReads();
  }

  #onReceipt(receipt: Extract<ServerFrame, { type: 'receipt' }>): void {
    if (receipt.userId === this.#selfId) {
      this.#reads.seed(receipt.roomId, receipt.read);
      return;
    }
    const readers =
      this.#readers.get(receipt.roomId) ??
      new Map<number, Extract<ServerFrame, { type: 'receipt' }>>();
    const known = readers.get(receipt.userId);
    if (receipt.read !== null && (known?.read ?? '') < receipt.read) {
      readers.set(receipt.userId, receipt);
      this.#readers.set(receipt.roomId, readers);
    }
    const ownUserId = this.#selfId;
    for (const entry of this.#roomEntries(receipt.roomId).values()) {
      if (
        entry.senderId === ownUserId &&
        entry.id !== null &&
        readReceiptCovers(receipt, { messageId: entry.id, ownUserId })
      ) {
        this.#setStatus(entry.idempotencyKey, 'read');
      }
    }
  }

  async #onRotated(roomId: string, keyEpoch: number): Promise<void> {
    const room = this.#rooms.get(roomId);
    if (room && keyEpoch > room.keyEpoch) {
      this.#rooms.set(roomId, { ...room, keyEpoch });
    }
    // Membership changed: refresh the member lists, then distribute a chain key for the new epoch.
    await this.#reloadRooms();
    await this.#keeper.ensureEpoch(roomId, keyEpoch, this.#rooms.get(roomId)?.memberIds);
  }

  async #onSenderKeys(roomId: string, keyEpoch: number): Promise<void> {
    this.#envelopes.invalidate(roomId, keyEpoch);
    const waiting = [...this.#undecrypted.values()].filter(
      (message) => message.roomId === roomId && message.keyEpoch === keyEpoch,
    );
    await Promise.all(waiting.map(async (message) => this.#receive(message)));
    this.#renderMessages(roomId);
  }

  #onState(state: ConnectionState): void {
    const previous = this.#state;
    this.#state = state;
    this.#deps.view.renderConnection(state);
    if (previous === 'open' && state !== 'open') {
      this.#flusher.onDisconnect();
    }
  }

  #onTyping(roomId: string, userId: number, active: boolean): void {
    if (userId === this.#selfId) {
      return;
    }
    this.#roster.set(roomId, userId, active, this.#deps.now());
    this.#renderTyping();
    if (this.#typingTimer !== null) {
      this.#deps.timers.clearTimeout(this.#typingTimer);
    }
    this.#typingTimer = this.#deps.timers.setTimeout(() => {
      this.#typingTimer = null;
      this.#renderTyping();
    }, TYPING_TTL_MS);
  }

  /** Decrypts a stored message and records it; one that fails waits for new sender keys. */
  async #receive(message: MessageView): Promise<void> {
    const text = await this.#decrypt(message);
    const key = message.idempotencyKey;
    const entries = this.#roomEntries(message.roomId);
    entries.set(key, toEntry(message, text ?? entries.get(key)?.text ?? null));
    if (text === null) {
      this.#undecrypted.set(message.id, message);
    } else {
      this.#undecrypted.delete(message.id);
      this.#remember(message, text);
    }
    if (message.senderId === this.#selfId) {
      const ownUserId = this.#selfId;
      const readers = this.#readers.get(message.roomId)?.values() ?? [];
      const read = [...readers].some((receipt) =>
        readReceiptCovers(receipt, { messageId: message.id, ownUserId }),
      );
      this.#setStatus(key, read ? 'read' : 'delivered');
    }
  }

  async #reloadRooms(): Promise<void> {
    const rooms = await this.#deps.api.listRooms();
    if (rooms.kind !== 'ok') {
      return;
    }
    for (const room of rooms.value) {
      this.#upsertRoom(room);
    }
    this.#renderAll();
  }

  /** Keeps the decrypted text in the local store, the only place search runs (S15). */
  #remember(message: MessageView, text: string): void {
    const { createdAt, id, roomId, senderId } = message;
    this.#deps.store.put({ createdAt, id, roomId, senderId, text }).catch(() => null);
  }

  #renderAll(): void {
    this.#deps.view.renderRooms(toRoomItems(this.#rooms.values(), this.#activeRoomId));
    this.#renderHeader();
    if (this.#activeRoomId === null) {
      this.#deps.view.renderMessages([], false);
    } else {
      this.#renderMessages(this.#activeRoomId);
    }
    this.#renderTyping();
  }

  #renderHeader(): void {
    const room = this.#activeRoomId === null ? undefined : this.#rooms.get(this.#activeRoomId);
    this.#deps.view.renderRoom(
      room
        ? toRoomHeader(room, {
            names: this.#names,
            online: this.#online.get(room.id) ?? new Set(),
            selfId: this.#selfId,
          })
        : null,
    );
  }

  #renderMessages(roomId: string): void {
    if (roomId !== this.#activeRoomId) {
      return;
    }
    const items = toMessageItems(this.#roomEntries(roomId).values(), {
      formatTime: this.#deps.formatTime,
      names: this.#names,
      selfId: this.#selfId,
      statuses: this.#statuses,
    });
    this.#deps.view.renderMessages(items, this.#cursorOf(roomId).hasOlder);
  }

  #renderTyping(): void {
    const roomId = this.#activeRoomId;
    const typers = roomId === null ? [] : this.#roster.typingIn(roomId, this.#deps.now());
    this.#deps.view.renderTyping(
      typingLabel(typers.map((userId) => displayName(userId, this.#selfId, this.#names))),
    );
  }

  async #requireEpoch(room: RoomSummary): Promise<void> {
    if (!(await this.#keeper.ensureEpoch(room.id, room.keyEpoch, room.memberIds))) {
      throw new Error('Sender keys are not distributed yet');
    }
  }

  #roomEntries(roomId: string): Map<string, MessageEntry> {
    let entries = this.#entries.get(roomId);
    if (!entries) {
      entries = new Map();
      this.#entries.set(roomId, entries);
    }
    return entries;
  }

  #scheduleFlushRetry(): void {
    if (this.#retryTimer !== null) {
      return;
    }
    this.#retryTimer = this.#deps.timers.setTimeout(() => {
      this.#retryTimer = null;
      this.#flusher.onReady();
    }, FLUSH_RETRY_MS);
  }

  #setStatus(key: string, status: LocalMessageStatus): void {
    this.#statuses.set(key, mergeStatus(this.#statuses.get(key), status));
    const roomId = this.#queuedRooms.get(key) ?? this.#activeRoomId;
    if (roomId !== null) {
      this.#renderMessages(roomId);
    }
  }

  /** Fetches the names of the room's members, so senders show by name after a fresh sign-in (S2). */
  async #loadNames(roomId: string): Promise<void> {
    this.#namesLoading.add(roomId);
    const members = await this.#deps.api.roomMembers(roomId);
    this.#namesLoading.delete(roomId);
    if (members.kind !== 'ok') {
      return;
    }
    for (const member of members.value) {
      this.#names.set(member.id, member.name);
    }
    this.#renderAll();
  }

  #upsertRoom(room: RoomSummary): void {
    const known = this.#rooms.get(room.id);
    const keyEpoch = Math.max(room.keyEpoch, known?.keyEpoch ?? 0);
    this.#rooms.set(room.id, { ...room, keyEpoch });
    this.#renderAll();
    if (room.memberIds.some((id) => !this.#names.has(id)) && !this.#namesLoading.has(room.id)) {
      void this.#loadNames(room.id);
    }
    if (known?.keyEpoch !== keyEpoch) {
      void this.#keeper.ensureEpoch(room.id, keyEpoch, room.memberIds);
    }
  }
}

function messageOf(outcome: { readonly kind: string; readonly message?: string }): string {
  if (outcome.kind === 'rate-limited') {
    return 'Too many requests. Please wait a moment.';
  }
  return outcome.message ?? 'Something went wrong. Please try again.';
}

function toEntry(message: MessageView, text: null | string): MessageEntry {
  return {
    createdAt: message.createdAt,
    failed: false,
    id: message.id,
    idempotencyKey: message.idempotencyKey,
    roomId: message.roomId,
    senderId: message.senderId,
    text,
  };
}
