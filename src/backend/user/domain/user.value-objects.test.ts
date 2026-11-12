import { describe, expect, test } from 'bun:test';

import { Password, UserName } from './user.value-objects.ts';

describe('UserName', () => {
  test.each(['alice', 'Alice42', '42', 'José'])('accepts %p', (raw) => {
    const result = UserName.create(raw);
    expect(result.ok && result.value.equals(UserName.restore(raw))).toBe(true);
  });

  test.each(['alice smith', ' alice', 'alice!', 'al-ice', 'a_b'])('rejects %p', (raw) => {
    expect(UserName.create(raw)).toEqual({
      error: { field: 'name', message: 'Name must contain only letters and numbers, without spaces' },
      ok: false,
    });
  });

  test.each(['', undefined, 42])('requires a string, got %p', (raw) => {
    expect(UserName.create(raw)).toEqual({ error: { field: 'name', message: 'Name is required' }, ok: false });
  });
});

describe('Password', () => {
  test('accepts a password zxcvbn scores as strong', () => {
    expect(Password.create('correct-Horse-battery-st4ple').ok).toBe(true);
  });

  test.each(['password', '12345678', 'qwerty123'])('rejects the weak password %p', (raw) => {
    expect(Password.create(raw)).toEqual({ error: { field: 'password', message: 'Password is too weak' }, ok: false });
  });

  test('rejects a password built from the user name', () => {
    // Strong on its own (score 4), so only the user-input check can reject it.
    expect(Password.create('zephyrQuill42').ok).toBe(true);
    expect(Password.create('zephyrQuill42', ['zephyrQuill42'])).toEqual({
      error: { field: 'password', message: 'Password is too weak' },
      ok: false,
    });
  });

  test.each(['', undefined, null])('requires a string, got %p', (raw) => {
    expect(Password.create(raw)).toEqual({ error: { field: 'password', message: 'Password is required' }, ok: false });
  });
});
