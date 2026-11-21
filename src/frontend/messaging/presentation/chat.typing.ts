import type { Timers } from '../connection/messaging.connection.ts';

import { messages } from '../../i18n/i18n.messages.ts';

export type TypingThrottleDeps = {
  /** After this long without a keystroke, `active:false` is sent. */
  readonly idleMs: number;
  /** While typing, `active:true` is repeated at most this often. */
  readonly intervalMs: number;
  readonly now: () => number;
  readonly send: (roomId: string, active: boolean) => void;
  readonly timers: Timers;
};

/** Default timings: one `active:true` about every 3 s while typing, `active:false` after 5 s idle. */
export const TYPING_IDLE_MS = 5000;
export const TYPING_INTERVAL_MS = 3000;
/** A remote `active:true` that is not repeated or cancelled stops showing after this long. */
export const TYPING_TTL_MS = 6000;

/** Remote typers per room, each until it says it stopped or its last `active:true` expires. */
export class TypingRoster {
  readonly #rooms = new Map<string, Map<number, number>>();
  readonly #ttlMs: number;

  constructor(ttlMs: number = TYPING_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  set(roomId: string, userId: number, active: boolean, now: number): void {
    const room = this.#rooms.get(roomId) ?? new Map<number, number>();
    if (active) {
      room.set(userId, now + this.#ttlMs);
    } else {
      room.delete(userId);
    }
    this.#rooms.set(roomId, room);
  }

  /** User ids typing in the room right now, in the order they started. */
  typingIn(roomId: string, now: number): number[] {
    const room = this.#rooms.get(roomId);
    if (!room) {
      return [];
    }
    return [...room].filter(([, expiresAt]) => expiresAt > now).map(([userId]) => userId);
  }
}

/**
 * Turns keystrokes into throttled `typing` frames: `active:true` on the first keystroke and then at
 * most once per interval, `active:false` once the user goes idle or sends.
 */
export class TypingThrottle {
  #active: null | string = null;
  readonly #deps: TypingThrottleDeps;
  #idleTimer: null | number = null;
  #lastSentAt = 0;

  constructor(deps: TypingThrottleDeps) {
    this.#deps = deps;
  }

  /** A keystroke in the composer of `roomId`. */
  input(roomId: string): void {
    if (this.#active !== null && this.#active !== roomId) {
      this.stop();
    }
    const now = this.#deps.now();
    if (this.#active === null || now - this.#lastSentAt >= this.#deps.intervalMs) {
      this.#active = roomId;
      this.#lastSentAt = now;
      this.#deps.send(roomId, true);
    }
    this.#clearIdle();
    this.#idleTimer = this.#deps.timers.setTimeout(() => {
      this.#idleTimer = null;
      this.stop();
    }, this.#deps.idleMs);
  }

  /** The user sent the message, went idle or left the room. */
  stop(): void {
    this.#clearIdle();
    const roomId = this.#active;
    if (roomId !== null) {
      this.#active = null;
      this.#deps.send(roomId, false);
    }
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      this.#deps.timers.clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}

export function typingLabel(names: readonly string[]): string {
  return messages().typing(names);
}
