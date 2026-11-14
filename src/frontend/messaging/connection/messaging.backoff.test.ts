import { describe, expect, test } from 'bun:test';

import { backoffDelay } from './messaging.backoff.ts';

const almostOne = (): number => 1 - Number.EPSILON;

describe('backoffDelay', () => {
  test('the ceiling grows as 2^attempt times the base', () => {
    const delays = [0, 1, 2, 3].map((attempt) => backoffDelay(attempt, { random: almostOne }));
    expect(delays).toEqual([999, 1999, 3999, 7999]);
  });

  test('never exceeds the cap, even for huge attempts or a random() of 1', () => {
    expect(backoffDelay(5, { capMs: 30_000, random: almostOne })).toBe(29_999);
    expect(backoffDelay(10_000, { random: () => 1 })).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(10, { baseMs: 100, capMs: 5000, random: () => 1 })).toBe(5000);
  });

  test('applies full jitter: the delay is random() times the capped ceiling', () => {
    expect(backoffDelay(2, { random: () => 0 })).toBe(0);
    expect(backoffDelay(2, { random: () => 0.5 })).toBe(2000);
    expect(backoffDelay(2, { random: () => 0.25 })).toBe(1000);
  });

  test('a negative attempt is treated as the first one', () => {
    expect(backoffDelay(-3, { random: () => 0.5 })).toBe(500);
  });
});
