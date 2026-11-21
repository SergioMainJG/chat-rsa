import { describe, expect, test } from 'bun:test';

import { describedByWith } from './form-validity.ts';

describe('describedByWith', () => {
  test('lists the error after the hint while the error is shown', () => {
    expect(describedByWith('name-hint', 'name-error', true)).toBe('name-hint name-error');
  });

  test('lists the error once, even when it was already listed', () => {
    expect(describedByWith('name-error name-hint', 'name-error', true)).toBe('name-hint name-error');
  });

  test('keeps only the other ids once the error is hidden', () => {
    expect(describedByWith('name-hint  name-error', 'name-error', false)).toBe('name-hint');
  });

  test('asks to remove the attribute when nothing is left', () => {
    expect(describedByWith('name-error', 'name-error', false)).toBeNull();
    expect(describedByWith(null, 'name-error', false)).toBeNull();
  });

  test('describes a field without other ids by its error alone', () => {
    expect(describedByWith(null, 'name-error', true)).toBe('name-error');
  });
});
