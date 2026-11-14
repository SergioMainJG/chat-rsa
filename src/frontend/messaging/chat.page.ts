// Browser entry of the chat page: a thin DOM adapter over ChatController. It renders view-models
// with textContent only (message text is untrusted), toggles attributes that CSS draws, and wires
// the browser APIs (IndexedDB, WebSocket, IntersectionObserver) into the application layer.
import type { MessageItem, RoomHeader, RoomItem } from './presentation/chat.view-model.ts';

import { SOCKET_PATH } from '../../shared/contracts/messaging.socket.contract.ts';
import {
  clearSessionHint,
  enforceAccess,
  revealPage,
  sessionHint,
} from '../auth/auth.page-guard.ts';
import { hasLiveSession } from '../auth/presentation/auth.view.ts';
import { ChatController, type SearchResult } from './application/chat.controller.ts';
import { bootstrapSession, type SessionHint, SIGN_IN_PATH } from './application/chat.session.ts';
import {
  browserNetwork,
  browserTimers,
  createBrowserSocket,
} from './connection/messaging.browser.ts';
import { type ConnectionState, SocketConnection } from './connection/messaging.connection.ts';
import { openIndexedDbOutbox } from './connection/messaging.outbox.indexed-db.ts';
import { InMemoryOutbox } from './connection/messaging.outbox.ts';
import { IndexedDbKeyStore } from './crypto/messaging.crypto.key-store.ts';
import { connectionBannerText } from './presentation/chat.status.ts';
import { IndexedDbLocalMessageStore } from './search/messaging.search.ts';

/** A message counts as seen when this much of it is inside the message list (S7). */
const READ_VISIBILITY_THRESHOLD = 0.6;
/** Within this distance of the bottom, new messages keep the list scrolled to the end. */
const STICK_TO_BOTTOM_PX = 80;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

// The JWT is in an HttpOnly cookie this page never sees; only its expiry hint is readable.
const hint: SessionHint = {
  clear: clearSessionHint,
  isLive: () => hasLiveSession(sessionHint(), Date.now()),
};

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new TypeError(`Missing ${selector}`);
  }
  return found;
}

const ui = {
  addMemberForm: element('[data-add-member-form]', HTMLFormElement),
  banner: element('[data-connection-banner]', HTMLElement),
  composer: element('[data-composer]', HTMLFormElement),
  createRoomForm: element('[data-create-room-form]', HTMLFormElement),
  keyWarningList: element('[data-key-warning-list]', HTMLUListElement),
  keyWarnings: element('[data-key-warnings]', HTMLElement),
  leaveRoom: element('[data-leave-room]', HTMLButtonElement),
  loadOlder: element('[data-load-older]', HTMLButtonElement),
  members: element('[data-members]', HTMLUListElement),
  messages: element('[data-messages]', HTMLOListElement),
  messageTemplate: element('[data-message-template]', HTMLTemplateElement),
  notice: element('[data-notice]', HTMLElement),
  roomName: element('[data-room-name]', HTMLElement),
  roomPanel: element('[data-room-panel]', HTMLElement),
  rooms: element('[data-rooms]', HTMLUListElement),
  /** CSS-only switch between the rooms list and the open room on narrow screens. */
  roomsToggle: element('#rooms-toggle', HTMLInputElement),
  scroller: element('[data-messages-scroller]', HTMLElement),
  searchEmpty: element('[data-search-empty]', HTMLElement),
  searchForm: element('[data-search-form]', HTMLFormElement),
  searchResults: element('[data-search-results]', HTMLOListElement),
  signInLink: element('[data-sign-in-link]', HTMLAnchorElement),
  signOut: element('[data-sign-out]', HTMLButtonElement),
  typing: element('[data-typing]', HTMLElement),
};

/** Message elements by item key, reused across renders so observers and focus survive. */
const messageElements = new Map<string, HTMLLIElement>();
const observed = new Set<string>();
let controller: ChatController | null = null;

function formMessage(form: HTMLFormElement, text: string): void {
  const output = form.querySelector('[data-form-message]');
  if (output) {
    output.textContent = text;
  }
}

function formText(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}

/** Runs a form request with the form busy (its fieldset disabled); shows its error, if any. */
function nearBottom(): boolean {
  const { clientHeight, scrollHeight, scrollTop } = ui.scroller;
  return scrollHeight - scrollTop - clientHeight < STICK_TO_BOTTOM_PX;
}

async function runBusy(form: HTMLFormElement, work: () => Promise<null | string>): Promise<void> {
  const fieldset = form.querySelector('fieldset');
  formMessage(form, '');
  form.setAttribute('aria-busy', 'true');
  if (fieldset) {
    fieldset.disabled = true;
  }
  try {
    const error = await work();
    if (error === null) {
      form.reset();
    } else {
      formMessage(form, error);
    }
  } finally {
    form.setAttribute('aria-busy', 'false');
    if (fieldset) {
      fieldset.disabled = false;
    }
  }
}

const readObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const id = entry.target instanceof HTMLElement ? entry.target.dataset.messageId : undefined;
      if (id !== undefined) {
        controller?.messageVisibility(id, entry.isIntersecting);
      }
    }
    controller?.flushReads();
  },
  { root: ui.scroller, threshold: READ_VISIBILITY_THRESHOLD },
);

function initialRoomId(): null | string {
  return new URLSearchParams(location.hash.slice(1)).get('room');
}

async function main(): Promise<void> {
  // Only a live session may see the chat; anyone else goes to /sign-in before the first paint.
  if (!enforceAccess('members')) {
    return;
  }
  showConnection('connecting');
  const result = await bootstrapSession({
    fetch: async (url, init) => fetch(url, init),
    hint,
    keyStoreFor: (userId) => new IndexedDbKeyStore(userId),
    navigate: (path) => {
      location.assign(path);
    },
  });
  if (result.kind === 'redirected') {
    // The server refused the token (revoked or invalid): leave without ever showing the page.
    return;
  }
  revealPage();
  if (result.kind === 'failed') {
    ui.notice.textContent = `Could not start the chat: ${result.message}`;
    showConnection('closed');
    return;
  }
  const { session } = result;
  const outbox = await openIndexedDbOutbox(session.user.id).catch(() => new InMemoryOutbox());
  const chat = new ChatController({
    api: session.api,
    connect: ({ onFrame, onState }) =>
      new SocketConnection({
        createSocket: createBrowserSocket,
        network: browserNetwork,
        now: Date.now,
        onFrame,
        onState,
        random: Math.random,
        refreshSession: session.refreshSession,
        timers: browserTimers,
        url: socketUrl(),
      }),
    crypto: session.crypto,
    formatTime: (iso) => timeFormat.format(new Date(iso)),
    isDocumentVisible: () => document.visibilityState === 'visible',
    now: Date.now,
    outbox,
    randomUUID: () => crypto.randomUUID(),
    store: new IndexedDbLocalMessageStore(session.user.id),
    timers: browserTimers,
    user: session.user,
    view: {
      notify: (text) => {
        ui.notice.textContent = text;
      },
      renderConnection: showConnection,
      renderKeyWarnings: (warnings) => {
        ui.keyWarningList.replaceChildren(
          ...warnings.map((warning) => {
            const li = document.createElement('li');
            li.textContent = warning;
            return li;
          }),
        );
        ui.keyWarnings.hidden = warnings.length === 0;
      },
      renderMessages,
      renderRoom: (header) => {
        ui.roomPanel.hidden = header === null;
        ui.roomName.textContent = header?.name ?? '';
        if (header) {
          renderMembers(header);
        }
      },
      renderRooms,
      renderSearch,
      renderTyping: (text) => {
        ui.typing.textContent = text;
      },
    },
  });
  controller = chat;
  wire(chat);
  ui.keyWarnings.querySelector('[data-trust-keys]')?.addEventListener('click', () => {
    void chat.trustNewKeys();
  });
  ui.signOut.addEventListener('click', () => {
    ui.signOut.disabled = true;
    ui.signOut.setAttribute('aria-busy', 'true');
    chat.stop();
    void session
      .signOut()
      .catch(() => null)
      .finally(() => {
        // replace, not assign: Back must not return to the chat of a session that is over.
        location.replace(SIGN_IN_PATH);
      });
  });
  await chat.start(initialRoomId());
  rememberRoom(chat.activeRoomId);
}

function messageElement(item: MessageItem): HTMLLIElement {
  let li = messageElements.get(item.key);
  if (!li) {
    const fragment = ui.messageTemplate.content.cloneNode(true);
    const created = fragment instanceof DocumentFragment ? fragment.firstElementChild : null;
    if (!(created instanceof HTMLLIElement)) {
      throw new TypeError('Bad message template');
    }
    li = created;
    messageElements.set(item.key, li);
  }
  li.dataset.own = String(item.own);
  li.dataset.status = item.status ?? '';
  li.dataset.failed = String(item.failed);
  li.dataset.undecryptable = String(item.undecryptable);
  setText(li, '.message-sender', item.sender);
  setText(li, '.message-text', item.text);
  setText(li, '.message-status-label', item.statusLabel);
  const time = li.querySelector('time');
  if (time) {
    time.dateTime = item.time;
    time.textContent = item.timeLabel;
  }
  if (item.id !== null && !item.own && !observed.has(item.key)) {
    li.dataset.messageId = item.id;
    observed.add(item.key);
    readObserver.observe(li);
  }
  return li;
}

async function openRoom(roomId: string): Promise<void> {
  // On narrow screens picking a room (from the list or a search result) shows that room.
  ui.roomsToggle.checked = false;
  await controller?.openRoom(roomId);
  rememberRoom(controller?.activeRoomId ?? null);
}

function rememberRoom(roomId: null | string): void {
  const hash = roomId === null ? '' : `#room=${encodeURIComponent(roomId)}`;
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function renderMembers(header: RoomHeader): void {
  ui.members.replaceChildren(
    ...header.members.map((member) => {
      const li = document.createElement('li');
      li.dataset.online = String(member.online);
      li.textContent = member.label;
      const state = document.createElement('span');
      state.className = 'visually-hidden';
      state.textContent = member.online ? ' (online)' : ' (offline)';
      li.append(state);
      return li;
    }),
  );
}

function renderMessages(items: readonly MessageItem[], hasOlder: boolean): void {
  const stick = nearBottom();
  const keys = new Set(items.map((item) => item.key));
  for (const [key, li] of messageElements) {
    if (!keys.has(key)) {
      readObserver.unobserve(li);
      observed.delete(key);
      messageElements.delete(key);
    }
  }
  const ordered = items.map((item) => messageElement(item));
  const current = [...ui.messages.children];
  if (ordered.length !== current.length || ordered.some((li, index) => li !== current[index])) {
    ui.messages.replaceChildren(...ordered);
  }
  ui.loadOlder.hidden = !hasOlder;
  if (stick) {
    ui.scroller.scrollTop = ui.scroller.scrollHeight;
  }
}

function renderRooms(rooms: readonly RoomItem[]): void {
  ui.rooms.replaceChildren(
    ...rooms.map((room) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.roomId = room.id;
      button.setAttribute('aria-current', String(room.active));
      const name = document.createElement('span');
      name.textContent = room.name;
      const count = document.createElement('span');
      count.className = 'room-count';
      count.textContent = `${room.memberCount} members`;
      button.append(name, count);
      li.append(button);
      return li;
    }),
  );
}

function renderSearch(results: readonly SearchResult[], query: string): void {
  ui.searchResults.replaceChildren(
    ...results.map((result) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.roomId = result.roomId;
      const meta = document.createElement('span');
      meta.className = 'search-result-meta';
      meta.textContent = `${result.roomName} · ${result.sender} · ${result.timeLabel}`;
      const text = document.createElement('span');
      text.className = 'search-result-text';
      text.textContent = result.text;
      button.append(meta, text);
      li.append(button);
      return li;
    }),
  );
  ui.searchEmpty.hidden = query.trim() === '' || results.length > 0;
}

function setText(root: ParentNode, selector: string, text: string): void {
  const target = root.querySelector(selector);
  if (target) {
    target.textContent = text;
  }
}

function showConnection(state: ConnectionState): void {
  ui.banner.dataset.state = state;
  ui.banner.textContent = connectionBannerText(state);
  ui.signInLink.hidden = state !== 'unauthorized';
}

function socketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${SOCKET_PATH}`;
}

function wire(chat: ChatController): void {
  ui.rooms.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const roomId = button?.dataset.roomId;
    if (roomId !== undefined) {
      void openRoom(roomId);
    }
  });
  ui.searchResults.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const roomId = button?.dataset.roomId;
    if (roomId !== undefined) {
      void openRoom(roomId);
    }
  });
  ui.createRoomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = ui.createRoomForm;
    const name = formText(form, 'name');
    const members = formText(form, 'members');
    void (async (): Promise<void> => {
      await runBusy(form, async () => chat.createRoom(name, members));
      rememberRoom(chat.activeRoomId);
    })();
  });
  ui.addMemberForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = formText(ui.addMemberForm, 'name');
    void runBusy(ui.addMemberForm, async () => chat.addMember(name));
  });
  ui.leaveRoom.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const error = await chat.leaveRoom();
      ui.notice.textContent = error ?? '';
      rememberRoom(chat.activeRoomId);
    })();
  });
  ui.loadOlder.addEventListener('click', () => {
    // Keep the messages on screen where they are while older ones are added above them.
    const fromBottom = ui.scroller.scrollHeight - ui.scroller.scrollTop;
    void (async (): Promise<void> => {
      await chat.loadOlder();
      ui.scroller.scrollTop = ui.scroller.scrollHeight - fromBottom;
    })();
  });
  ui.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  ui.searchForm.addEventListener('input', () => {
    void chat.search(formText(ui.searchForm, 'query'));
  });
  const textarea = ui.composer.elements.namedItem('text');
  ui.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (textarea instanceof HTMLTextAreaElement) {
      const text = textarea.value;
      textarea.value = '';
      void chat.send(text);
    }
  });
  ui.composer.addEventListener('input', () => {
    chat.composerInput();
  });
  ui.composer.addEventListener('keydown', (event) => {
    // Enter sends, Shift+Enter adds a line; never while an IME is composing text.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      ui.composer.requestSubmit();
    }
  });
  document.addEventListener('visibilitychange', () => {
    chat.flushReads();
  });
  globalThis.addEventListener('pagehide', () => {
    chat.stop();
  });
}

// A page restored from the back/forward cache after sign-out must not show the old chat.
globalThis.addEventListener('pageshow', (event) => {
  if (event instanceof PageTransitionEvent && event.persisted) {
    enforceAccess('members');
  }
});

await main();
