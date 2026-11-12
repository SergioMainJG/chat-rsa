import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';
import { describe, expect, test } from 'bun:test';

import { MIN_PASSWORD_SCORE, Password } from './user.value-objects.ts';

// BUG-HIGH-03: only scores 0-1 and 4 were exercised, so `<` -> `<=` at MIN_PASSWORD_SCORE survived.
// Each fixture's score is asserted first, so a dictionary update cannot silently move the boundary.

const zxcvbn = new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });

describe('Password strength boundary at MIN_PASSWORD_SCORE', () => {
  test('the accepted minimum is a score of 3', () => {
    expect(MIN_PASSWORD_SCORE).toBe(3);
  });

  test.each(['tiger-Lamp3', 'purple-monkey7'])('accepts %p, which scores exactly 3', (raw) => {
    expect(zxcvbn.check(raw).score).toBe(3);
    expect(Password.create(raw).ok).toBe(true);
  });

  test.each(['blue7Kite', 'n8Kp2vQx'])('rejects %p, which scores exactly 2', (raw) => {
    expect(zxcvbn.check(raw).score).toBe(2);
    expect(Password.create(raw)).toEqual({ error: { field: 'password', message: 'Password is too weak' }, ok: false });
  });
});
