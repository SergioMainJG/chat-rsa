import { describe, expect, test } from 'bun:test';

import { newRunId, runUserPattern } from './k6-runner.ts';

// BUG-MEDIUM-06 (load): the cleanup was `LIKE 'load<runId>%'`, which becomes `LIKE 'load%'` and
// deletes `loader` or `loadbalancer` if runId is ever empty. The delete pattern must be exact.

describe('runUserPattern', () => {
  test.each(['', '0', 'abc', 'has space', 'UPPER123', 'mwdo1ixq%', "mwdo1ixq' OR 1=1"])(
    'refuses the malformed runId %p instead of widening the match',
    (runId) => {
      expect(() => runUserPattern(runId)).toThrow('Refusing to build a delete pattern');
    },
  );

  test('matches exactly the pool, sign-up and messaging names of its own run', () => {
    const pattern = new RegExp(runUserPattern('mwdo1ixq'), 'u');

    for (const name of [
      'loadmwdo1ixqp0',
      'loadmwdo1ixqp19',
      'loadmwdo1ixqu0',
      'loadmwdo1ixqu1234',
      'loadmwdo1ixqm0',
      'loadmwdo1ixqm42',
    ]) {
      expect(pattern.test(name)).toBe(true);
    }
  });

  test.each([
    'loader',
    'loadbalancer',
    'load',
    'loadmwdo1ixq',
    'loadmwdo1ixqx1',
    'loadmwdo1ixqm',
    'loadmwdo1ixqp',
    'xloadmwdo1ixqp1',
    'loadmwdo1ixqp1x',
    'loadotherrunp1',
  ])('never matches %p', (name) => {
    expect(new RegExp(runUserPattern('mwdo1ixq'), 'u').test(name)).toBe(false);
  });
});

test('newRunId produces an id runUserPattern accepts', () => {
  expect(() => runUserPattern(newRunId())).not.toThrow();
});
