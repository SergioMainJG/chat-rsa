import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { Cancel } from './messaging.socket.scheduler.ts';

import {
  type BucketPolicy,
  type BucketState,
  takeToken,
} from '../../shared/domain/token-bucket.ts';

/**
 * Per-socket state (`ws.data`). It is created at upgrade time from the verified JWT, so every field
 * the frame handlers read comes from the server, never from the client.
 */
export class SocketConnection {
  /** The sign-in session of the token that opened the socket; refreshes must keep it. */
  readonly sessionId: string;
  readonly userId: UserId;
  private bucket: BucketState | null = null;
  private cancelExpiry: Cancel | null = null;
  private expiry: number;
  private lastPong: number;
  private pending: Promise<void> = Promise.resolve();
  private released = false;
  private readonly roomIds = new Set<string>();

  constructor(userId: UserId, sessionId: string, expiresAt: number, now: number) {
    this.userId = userId;
    this.sessionId = sessionId;
    this.expiry = expiresAt;
    this.lastPong = now;
  }

  /** Epoch milliseconds when the current JWT expires. */
  get expiresAt(): number {
    return this.expiry;
  }

  get isReleased(): boolean {
    return this.released;
  }

  get lastPongAt(): number {
    return this.lastPong;
  }

  /**
   * Runs `task` after every task queued before it, so frames are handled in arrival order (an
   * offline outbox flushes in order). `task` must not reject.
   */
  async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task);
    this.pending = next;
    return next;
  }

  /** Records a room subscription; false when it was already recorded. */
  join(roomId: string): boolean {
    if (this.roomIds.has(roomId)) {
      return false;
    }
    this.roomIds.add(roomId);
    return true;
  }

  leave(roomId: string): boolean {
    return this.roomIds.delete(roomId);
  }

  pong(now: number): void {
    this.lastPong = now;
  }

  /** Frees the timers once. Returns the rooms it was in, or null when it was already released. */
  release(): null | string[] {
    if (this.released) {
      return null;
    }
    this.released = true;
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    const rooms = [...this.roomIds];
    this.roomIds.clear();
    return rooms;
  }

  /** Replaces the JWT expiry and its timer; the previous timer is cancelled. */
  renew(expiresAt: number, cancel: Cancel): void {
    this.cancelExpiry?.();
    this.expiry = expiresAt;
    this.cancelExpiry = cancel;
  }

  /** Spends `cost` tokens of this socket's frame budget; false when the budget is exhausted. */
  take(policy: BucketPolicy, now: number, cost: number): boolean {
    const outcome = takeToken(this.bucket, policy, now, cost);
    this.bucket = outcome.state;
    return outcome.allowed;
  }
}
