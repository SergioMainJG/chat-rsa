import { describe, expect, test } from 'bun:test';

import { takeToken } from './token-bucket.ts';

const POLICY = { capacity: 3, refillPerSecond: 1 };

describe('takeToken', () => {
  test('a new bucket starts full and allows a burst up to its capacity', () => {
    let state = null;
    const allowed: boolean[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { allowed: granted, state: next } = takeToken(state, POLICY, 0);
      allowed.push(granted);
      state = next;
    }
    expect(allowed).toEqual([true, true, true, false]);
  });

  test('an empty bucket reports when the next token arrives', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    expect(takeToken(empty, POLICY, 250)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      state: { tokens: 0.25, updatedAt: 250 },
    });
  });

  test('tokens refill over time but never above the capacity', () => {
    const outcome = takeToken({ tokens: 0, updatedAt: 0 }, POLICY, 60_000);
    expect(outcome.allowed).toBe(true);
    expect(outcome.state.tokens).toBe(2);
  });

  test('a clock that goes backwards never mints tokens', () => {
    const outcome = takeToken({ tokens: 0, updatedAt: 5000 }, POLICY, 1000);
    expect(outcome.allowed).toBe(false);
    expect(outcome.state.tokens).toBe(0);
  });
});
