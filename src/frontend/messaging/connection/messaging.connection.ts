import {
  type ClientFrame,
  CloseCode,
  type ServerFrame,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import { backoffDelay } from './messaging.backoff.ts';

/**
 * `connecting`: a socket is opening. `open`: the socket is open. `reconnecting`: waiting out a
 * backoff delay. `offline`: the network is down, so nothing retries until it recovers.
 * `unauthorized`: the server closed with 4001 or a refresh failed; sign in again. `closed`:
 * `close()` was called, or `start()` was not called yet.
 */
export type ConnectionState =
  'closed' | 'connecting' | 'offline' | 'open' | 'reconnecting' | 'unauthorized';

/** Source of the browser's online status (`navigator.onLine` plus `online`/`offline` events). */
export type NetworkStatus = {
  readonly isOnline: () => boolean;
  /** Calls the listener on every change; returns a function that unsubscribes it. */
  readonly onChange: (listener: (online: boolean) => void) => () => void;
};

export type SocketConnectionDeps = {
  /** Opens a socket that reports its events to the listener; see `createBrowserSocket`. */
  readonly createSocket: (url: string, protocols: string[], listener: SocketListener) => SocketLike;
  readonly network: NetworkStatus;
  /** Epoch milliseconds, for scheduling the token refresh. */
  readonly now: () => number;
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onState: (state: ConnectionState) => void;
  readonly random: () => number;
  /**
   * Renews the session cookie before the JWT expires (`POST /api/auth/refresh`); rejects when the
   * session is over. The server then pushes `auth.refreshed` to this socket.
   */
  readonly refreshSession: () => Promise<void>;
  readonly timers: Timers;
  readonly url: string;
};

/** The part of a WebSocket the connection uses. */
export type SocketLike = {
  readonly close: (code?: number) => void;
  readonly send: (data: string) => void;
};

export type SocketListener = {
  readonly onClose: (code: number) => void;
  readonly onMessage: (data: string) => void;
  readonly onOpen: () => void;
};

export type Timers = {
  readonly clearTimeout: (handle: number) => void;
  readonly setTimeout: (callback: () => void, ms: number) => number;
};

const NORMAL_CLOSURE = 1000;
/** The session is renewed this long before its JWT expires. */
export const REFRESH_LEAD_MS = 60_000;

/**
 * Only the `type` discriminator is checked: the server is the trusted side of this protocol, and
 * consumers ignore frame types they do not handle.
 */
function isFrame(value: unknown): value is ServerFrame {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function parseFrame(data: string): null | ServerFrame {
  try {
    const value: unknown = JSON.parse(data);
    return isFrame(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One authenticated WebSocket to the chat server that survives network loss: it reconnects with
 * exponential backoff and jitter (S4), waits while the browser is offline and reconnects as soon as
 * the network recovers, stops on an auth failure, and renews the session before its JWT expires
 * (S10).
 */
export class SocketConnection {
  get state(): ConnectionState {
    return this.#state;
  }

  /** Reconnection attempts since the last `ready` frame; it picks the backoff delay. */
  #attempt = 0;
  readonly #deps: SocketConnectionDeps;
  /** Bumped for every new socket, so events from a replaced socket are ignored. */
  #generation = 0;
  #refreshTimer: null | number = null;
  #retryTimer: null | number = null;
  #socket: null | SocketLike = null;
  #socketOpen = false;
  #state: ConnectionState = 'closed';
  #unsubscribeNetwork: (() => void) | null = null;

  constructor(deps: SocketConnectionDeps) {
    this.#deps = deps;
  }

  /** Stops for good: closes the socket normally and never reconnects. */
  close(): void {
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = null;
    this.#clearTimers();
    this.#setState('closed');
    this.#dropSocket();
  }

  isOpen(): boolean {
    return this.#socketOpen;
  }

  /** Writes the frame; false when the socket is not open, so the caller keeps it for later. */
  send(frame: ClientFrame): boolean {
    if (!this.#socketOpen || !this.#socket) {
      return false;
    }
    this.#socket.send(JSON.stringify(frame));
    return true;
  }

  /** Starts connecting and watching the network. */
  start(): void {
    if (this.#unsubscribeNetwork) {
      return;
    }
    this.#unsubscribeNetwork = this.#deps.network.onChange((online) => {
      this.#onNetworkChange(online);
    });
    this.#connect();
  }

  #clearRefresh(): void {
    if (this.#refreshTimer !== null) {
      this.#deps.timers.clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) {
      this.#deps.timers.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#clearRefresh();
  }

  #connect(): void {
    this.#retryTimer = null;
    if (!this.#deps.network.isOnline()) {
      this.#setState('offline');
      return;
    }
    this.#setState('connecting');
    this.#generation += 1;
    const generation = this.#generation;
    const isCurrent = (): boolean => this.#generation === generation && this.#socket !== null;
    const listener: SocketListener = {
      onClose: (code) => {
        if (isCurrent()) {
          this.#onClose(code);
        }
      },
      onMessage: (data) => {
        if (isCurrent()) {
          this.#onMessage(data);
        }
      },
      onOpen: () => {
        if (isCurrent()) {
          this.#socketOpen = true;
          this.#setState('open');
        }
      },
    };
    // The browser sends the HttpOnly session cookie with the upgrade; no token is visible here.
    this.#socket = this.#deps.createSocket(this.#deps.url, [SOCKET_PROTOCOL], listener);
  }

  #dropSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#socketOpen = false;
    socket?.close(NORMAL_CLOSURE);
  }

  #isStopped(): boolean {
    return this.#state === 'closed' || this.#state === 'unauthorized';
  }

  #onClose(code: number): void {
    this.#socket = null;
    this.#socketOpen = false;
    this.#clearRefresh();
    if (this.#isStopped()) {
      return;
    }
    if (code === CloseCode.AuthFailed) {
      this.#setState('unauthorized');
      return;
    }
    if (!this.#deps.network.isOnline()) {
      this.#setState('offline');
      return;
    }
    const delay = backoffDelay(this.#attempt, { random: this.#deps.random });
    this.#attempt += 1;
    this.#setState('reconnecting');
    this.#retryTimer = this.#deps.timers.setTimeout(() => {
      this.#connect();
    }, delay);
  }

  #onMessage(data: string): void {
    const frame = parseFrame(data);
    if (!frame) {
      return;
    }
    if (frame.type === 'ready') {
      this.#attempt = 0;
    }
    if (frame.type === 'ready' || frame.type === 'auth.refreshed') {
      this.#scheduleRefresh(frame.expiresAt);
    }
    this.#deps.onFrame(frame);
  }

  #onNetworkChange(online: boolean): void {
    if (this.#isStopped() || this.#socket) {
      return;
    }
    if (this.#retryTimer !== null) {
      this.#deps.timers.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (online) {
      // A recovered network is a new start: reconnect now, with the backoff reset.
      this.#attempt = 0;
      this.#connect();
    } else {
      this.#setState('offline');
    }
  }

  async #refresh(): Promise<void> {
    this.#refreshTimer = null;
    try {
      // The server answers with fresh cookies and pushes `auth.refreshed`, which schedules the next
      // refresh; without it the socket's expiry closes it with 4001.
      await this.#deps.refreshSession();
    } catch {
      if (!this.#isStopped()) {
        this.#clearTimers();
        this.#setState('unauthorized');
        this.#dropSocket();
      }
    }
  }

  #scheduleRefresh(expiresAt: string): void {
    this.#clearRefresh();
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry)) {
      return;
    }
    const delay = Math.max(0, expiry - REFRESH_LEAD_MS - this.#deps.now());
    this.#refreshTimer = this.#deps.timers.setTimeout(() => {
      void this.#refresh();
    }, delay);
  }

  #setState(state: ConnectionState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#deps.onState(state);
    }
  }
}
