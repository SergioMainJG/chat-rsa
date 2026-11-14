import type { NewMessage } from '../domain/messaging.message.entity.ts';
import type { AppendOutcome } from '../domain/messaging.repository.ts';
import type { Cancel, Scheduler } from './messaging.socket.scheduler.ts';

import { type TokenClaims, TokenVerifier } from '../../user/domain/user.security.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import { InMemoryMessageRepository } from '../application/messaging.fakes.test-support.ts';

type Timer = {
  cancelled: boolean;
  due: number;
  readonly every: null | number;
  readonly task: () => void;
};

/** Verifies tokens by looking them up in a table: the token string is its own fixture name. */
export class FakeTokenVerifier extends TokenVerifier {
  readonly tokens = new Map<string, TokenClaims>();

  /** Tokens of one user share the session `s<userId>` unless `sessionId` says otherwise. */
  add(token: string, userId: number, expiresAt: number, sessionId = `s${userId}`): this {
    this.tokens.set(token, {
      expiresAt: new Date(expiresAt),
      name: `user${userId}`,
      sessionId,
      sessionStartedAt: new Date(0),
      userId: UserId.restore(userId),
    });
    return this;
  }

  override async verify(token: string): Promise<null | TokenClaims> {
    return this.tokens.get(token) ?? null;
  }
}

/** Holds every `append` until `release()`, so tests can observe what happens before persistence. */
export class GatedMessageRepository extends InMemoryMessageRepository {
  readonly entered = Promise.withResolvers<null>();
  private gate: null | PromiseWithResolvers<null> = null;

  override async append(draft: NewMessage): Promise<AppendOutcome> {
    if (this.gate) {
      this.entered.resolve(null);
      await this.gate.promise;
    }
    return super.append(draft);
  }

  close(): void {
    this.gate = Promise.withResolvers<null>();
  }

  release(): void {
    this.gate?.resolve(null);
    this.gate = null;
  }
}

/** A clock and timers that only move when the test calls `advance`. */
export class ManualScheduler implements Scheduler {
  now: number;
  private readonly timers: Timer[] = [];

  constructor(start: number) {
    this.now = start;
  }

  readonly after = (ms: number, task: () => void): Cancel => this.add(ms, task, null);

  readonly repeat = (ms: number, task: () => void): Cancel => this.add(ms, task, ms);

  /** Moves the clock forward, firing every timer that falls due on the way, in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (let timer = this.nextDue(target); timer; timer = this.nextDue(target)) {
      this.now = timer.due;
      if (timer.every === null) {
        timer.cancelled = true;
      } else {
        timer.due += timer.every;
      }
      timer.task();
    }
    this.now = target;
  }

  pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }

  private add(ms: number, task: () => void, every: null | number): Cancel {
    const timer: Timer = { cancelled: false, due: this.now + ms, every, task };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  private nextDue(target: number): Timer | undefined {
    return this.timers
      .filter((timer) => !timer.cancelled && timer.due <= target)
      .toSorted((a, b) => a.due - b.due)
      .at(0);
  }
}
