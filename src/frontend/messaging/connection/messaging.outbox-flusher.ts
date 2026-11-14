import type {
  ClientFrame,
  ServerFrame,
  SocketErrorCode,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import type { Timers } from './messaging.connection.ts';
import type { LocalMessageStatus } from './messaging.message-status.ts';

import { newOutboxItem, type Outbox, type OutboxItem } from './messaging.outbox.ts';

/** Why a flush stopped before the outbox was empty; the items stay queued. */
export type FlushStop =
  | {
      readonly error: { readonly code: SocketErrorCode; readonly message: string };
      readonly idempotencyKey: string;
      /** The server refused the message (an `error` frame for its key). */
      readonly reason: 'rejected';
    }
  | {
      readonly idempotencyKey: string;
      readonly reason: 'ack-timeout' | 'disconnected' | 'encrypt-failed';
    };

export type OutboxFlusherDeps = {
  /** How long to wait for the `message.ack` of a sent item before stopping the flush. */
  readonly ackTimeoutMs: number;
  readonly connection: {
    readonly isOpen: () => boolean;
    readonly send: (frame: ClientFrame) => boolean;
  };
  /** Encrypts with the room's current sender key; called again for every retry. */
  readonly encrypt: (item: OutboxItem) => Promise<SendFrame>;
  readonly now: () => number;
  readonly onStatus: (idempotencyKey: string, status: LocalMessageStatus) => void;
  readonly onStop: (stop: FlushStop) => void;
  readonly outbox: Outbox;
  /** `crypto.randomUUID`, for idempotency keys. */
  readonly randomUUID: () => string;
  /**
   * Called before a `conflict` retry re-encrypts, so the caller can reload what the conflict says
   * is stale (the room's key epoch) instead of encrypting with it again.
   */
  readonly refresh?: (item: OutboxItem) => Promise<void>;
  readonly timers: Timers;
};

export type SendFrame = Extract<ClientFrame, { type: 'message.send' }>;

type Reply =
  | { readonly code: SocketErrorCode; readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ack' }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'reconnected' }
  | { readonly kind: 'timeout' };

type Waiter = {
  readonly idempotencyKey: string;
  readonly resolve: (reply: Reply) => void;
  readonly timer: number;
};

/**
 * Sends queued messages strictly in order, one at a time (S9): each item is encrypted, sent, and
 * acknowledged before the next one goes out. A disconnect, an ack timeout or a refused message
 * stops the flush with the rest still queued; `onReady()` resumes it from the oldest item, with the
 * same idempotency keys, so a resend never duplicates a stored message (S6).
 */
export class OutboxFlusher {
  readonly #deps: OutboxFlusherDeps;
  /** Set by a stop; only a new `ready` clears it, so the flush does not spin against a failure. */
  #halted = false;
  /** Counts flush requests; one that arrives during a running flush makes it go around again. */
  #requests = 0;
  #running: null | Promise<void> = null;
  #waiter: null | Waiter = null;

  constructor(deps: OutboxFlusherDeps) {
    this.#deps = deps;
  }

  /** Queues a message as `pending` and starts a flush. Every send goes through here. */
  async enqueue(roomId: string, text: string): Promise<OutboxItem> {
    const item = newOutboxItem(roomId, text, this.#deps);
    await this.#deps.outbox.enqueue(item);
    this.#deps.onStatus(item.idempotencyKey, 'pending');
    void this.flush();
    return item;
  }

  /** Sends the queued items; a call during a running flush joins it instead of starting another. */
  async flush(): Promise<void> {
    this.#requests += 1;
    this.#running ??= this.#drain().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Feeds `message.ack`, `error` and `ready` frames from the connection. */
  handleFrame(frame: ServerFrame): void {
    const pendingKey = this.#waiter?.idempotencyKey;
    if (frame.type === 'ready') {
      this.onReady();
    } else if (frame.type === 'message.ack' && frame.idempotencyKey === pendingKey) {
      this.#settle({ kind: 'ack' });
    } else if (frame.type === 'error' && frame.ref !== null && frame.ref === pendingKey) {
      this.#settle({ code: frame.code, kind: 'error', message: frame.message });
    }
  }

  /** The socket closed: the item waiting for its ack stays queued for the next flush. */
  onDisconnect(): void {
    this.#settle({ kind: 'disconnected' });
  }

  /**
   * The server sent `ready` on a new connection: resume from the oldest queued item. An item still
   * waiting for an ack from the previous socket is resent now instead of waiting out its timeout.
   */
  onReady(): void {
    this.#halted = false;
    if (this.#waiter) {
      this.#settle({ kind: 'reconnected' });
      return;
    }
    void this.flush();
  }

  async #awaitReply(idempotencyKey: string): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      const timer = this.#deps.timers.setTimeout(() => {
        this.#settle({ kind: 'timeout' });
      }, this.#deps.ackTimeoutMs);
      this.#waiter = { idempotencyKey, resolve, timer };
    });
  }

  /**
   * Sends one item and waits for its outcome; true when it was acknowledged. A `conflict` error
   * (the room's key epoch changed) refreshes, re-encrypts and retries once.
   */
  async #deliver(item: OutboxItem, retried = false): Promise<'deferred' | boolean> {
    const key = item.idempotencyKey;
    let frame: SendFrame;
    try {
      frame = await this.#deps.encrypt(item);
    } catch {
      // Reported by `#sendNext` once the other rooms had their turn.
      return 'deferred';
    }
    if (!this.#deps.connection.isOpen() || !this.#deps.connection.send(frame)) {
      return this.#stop({ idempotencyKey: key, reason: 'disconnected' });
    }
    this.#deps.onStatus(key, 'sent');
    const reply = await this.#awaitReply(key);
    switch (reply.kind) {
      case 'ack': {
        await this.#deps.outbox.remove(key);
        this.#deps.onStatus(key, 'delivered');
        return true;
      }
      case 'disconnected': {
        return this.#stop({ idempotencyKey: key, reason: 'disconnected' });
      }
      case 'error': {
        if (reply.code === 'conflict' && !retried) {
          await this.#deps.refresh?.(item).catch(() => null);
          return this.#deliver(item, true);
        }
        const error = { code: reply.code, message: reply.message };
        return this.#stop({ error, idempotencyKey: key, reason: 'rejected' });
      }
      case 'reconnected': {
        return this.#deliver(item, retried);
      }
      case 'timeout': {
        return this.#stop({ idempotencyKey: key, reason: 'ack-timeout' });
      }
      default: {
        return false;
      }
    }
  }

  async #drain(): Promise<void> {
    const requests = this.#requests;
    await this.#sendNext();
    if (this.#requests !== requests && !this.#halted) {
      await this.#drain();
    }
  }

  /**
   * Sends the oldest item, then the next, until the outbox is empty or the flush stops. An item
   * that cannot be encrypted yet (for example a member has no identity key) holds back only its own
   * room: that room's later items stay behind it, so order within a room is kept, while the other
   * rooms go on. The first held-back item is then reported as `encrypt-failed`.
   */
  async #sendNext(): Promise<void> {
    const deferred = new Map<string, string>();
    while (!this.#halted && this.#deps.connection.isOpen()) {
      // Sequential on purpose: one item in flight at a time, oldest first.
      // eslint-disable-next-line no-await-in-loop
      const queued = await this.#deps.outbox.list();
      const next = queued.find((item) => !deferred.has(item.roomId));
      if (!next) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.#deliver(next);
      if (outcome === 'deferred') {
        deferred.set(next.roomId, next.idempotencyKey);
      } else if (!outcome) {
        return;
      }
    }
    const [held] = deferred.values();
    if (held !== undefined && !this.#halted) {
      this.#stop({ idempotencyKey: held, reason: 'encrypt-failed' });
    }
  }

  /** Resolves the item waiting for its reply, if any, and cancels its ack timeout. */
  #settle(reply: Reply): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      this.#deps.timers.clearTimeout(waiter.timer);
      waiter.resolve(reply);
    }
  }

  #stop(stop: FlushStop): false {
    this.#halted = true;
    this.#deps.onStop(stop);
    return false;
  }
}
