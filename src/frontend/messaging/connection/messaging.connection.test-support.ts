// Deterministic doubles for the connection tests: manual timers, scripted sockets, a switchable
// network. Nothing here sleeps or opens a real socket.
import type { NetworkStatus, SocketLike, SocketListener, Timers } from './messaging.connection.ts';

export class FakeNetwork implements NetworkStatus {
  readonly #listeners = new Set<(online: boolean) => void>();
  #online: boolean;

  constructor(online = true) {
    this.#online = online;
  }

  isOnline = (): boolean => this.#online;

  onChange = (listener: (online: boolean) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(online: boolean): void {
    this.#online = online;
    for (const listener of this.#listeners) {
      listener(online);
    }
  }
}

export class FakeSocket implements SocketLike {
  closedWith: null | number = null;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols: readonly string[],
    readonly listener: SocketListener,
  ) {}

  close = (code?: number): void => {
    this.closedWith = code ?? 1005;
  };

  /** Simulates the server or the network closing the socket. */
  drop(code: number): void {
    this.listener.onClose(code);
  }

  open(): void {
    this.listener.onOpen();
  }

  receive(data: unknown): void {
    this.listener.onMessage(typeof data === 'string' ? data : JSON.stringify(data));
  }

  send = (data: string): void => {
    this.sent.push(data);
  };

  sentFrames(): unknown[] {
    return this.sent.map((data): unknown => JSON.parse(data));
  }
}

export class FakeTimers implements Timers {
  #nextId = 1;
  readonly #pending = new Map<number, { callback: () => void; ms: number }>();

  clearTimeout = (handle: number): void => {
    this.#pending.delete(handle);
  };

  /** Delays of the timers that have not fired or been cleared, in creation order. */
  delays(): number[] {
    return [...this.#pending.values()].map((timer) => timer.ms);
  }

  /** Fires the oldest pending timer; fails the test when there is none. */
  runNext(): void {
    const [entry] = this.#pending;
    if (!entry) {
      throw new Error('No pending timer');
    }
    const [id, timer] = entry;
    this.#pending.delete(id);
    timer.callback();
  }

  setTimeout = (callback: () => void, ms: number): number => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, { callback, ms });
    return id;
  };
}

/** Resolves after every queued microtask (promise continuation) has run. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
