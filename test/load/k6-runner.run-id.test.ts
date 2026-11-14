import { describe, expect, test } from 'bun:test';

import { newRunId, runUserPattern } from './k6-runner.ts';

// BUG-HIGH-06 (load run 2): the runId check must be anchored at both ends, and two runs started in
// the same millisecond must not share a runId (their users and cleanup patterns would collide).

describe('runUserPattern rejects junk before a valid-looking runId', () => {
  test.each(['%mwdo1ixq', '.*|mwdo1ixq', ' mwdo1ixq', '-mwdo1ixq', 'MWDO1IXQ', '|mwdo1ixq', '^mwdo1ixq'])(
    'refuses %p',
    (runId) => {
      expect(() => runUserPattern(runId)).toThrow('Refusing to build a delete pattern');
    },
  );

  // BUG-LOAD-RUN3-MED-02: dropping the `$` anchor would accept a valid runId followed by junk.
  test.each(['mwdo1ixq%', 'mwdo1ixq.*', 'mwdo1ixq|', 'mwdo1ixq\n', 'mwdo1ixq '])(
    'refuses trailing junk %p',
    (runId) => {
      expect(() => runUserPattern(runId)).toThrow('Refusing to build a delete pattern');
    },
  );

  test('the alternation injection never reaches the delete pattern', () => {
    // Unanchored, `.*|mwdo1ixq` would build `^load.*|mwdo1ixq[pum][0-9]+$`, which matches `loader`.
    expect(() => runUserPattern('.*|mwdo1ixq')).toThrow();
    expect(new RegExp(runUserPattern('mwdo1ixq'), 'u').test('loader')).toBe(false);
  });
});

describe('newRunId', () => {
  test('ids created in the same millisecond are all different', () => {
    const ids = Array.from({ length: 1000 }, () => newRunId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every id is accepted by runUserPattern and starts with the time in base 36', () => {
    const before = Date.now();
    const ids = Array.from({ length: 100 }, () => newRunId());
    const after = Date.now();
    for (const id of ids) {
      expect(() => runUserPattern(id)).not.toThrow();
      const time = Number.parseInt(id.slice(0, before.toString(36).length), 36);
      expect(time).toBeGreaterThanOrEqual(before);
      expect(time).toBeLessThanOrEqual(after);
    }
  });

  // BUG-LOAD-RUN3-MED-02: `byte * 36` instead of `byte % 36` still produced unique, valid ids, but
  // longer ones that always ended their characters in `0`. The random tail is exactly 8 characters
  // and draws on the whole base-36 alphabet.
  test('appends exactly 8 random characters spread over all of base 36', () => {
    const timeLength = Date.now().toString(36).length;
    const tails = Array.from({ length: 1000 }, () => newRunId()).map((id) => id.slice(timeLength));
    for (const tail of tails) {
      expect(tail).toMatch(/^[0-9a-z]{8}$/u);
    }
    expect(new Set(tails.join('')).size).toBe(36);
  });

  test('stays short enough for a user name (`load` + runId + kind + index, at most 64 characters)', () => {
    expect(`load${newRunId()}u9999`.length).toBeLessThanOrEqual(64);
  });
});
