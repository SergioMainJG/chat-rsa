import { describe, expect, test } from 'bun:test';

import { Password, PasswordHash } from '../../src/backend/user/domain/user.value-objects.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';

// The hasher runs on Bun.password (argon2id). Users created before the migration have hashes made
// by the `argon2` npm package (t=3, p=4); those must keep verifying, or those users get locked out.

const PLAIN = 'correct-Horse-battery-st4ple';
/** Produced by the `argon2` npm package (argon2id, m=65536, t=3, p=4) for PLAIN, before the migration. */
const LEGACY_HASH = PasswordHash.restore(
  '$argon2id$v=19$m=65536,t=3,p=4$3tBcNiOTIrGnUh/yDO5HpA$I+WCOWZBeH61gehtYcxvEzUStbw/afE0AXgQttE9lCg',
);

const hasher = new Argon2PasswordHasher();

function password(raw: string): Password {
  const result = Password.create(raw);
  if (!result.ok) {
    throw new Error(`fixture password rejected: ${result.error.message}`);
  }
  return result.value;
}

describe('Argon2PasswordHasher on Bun.password', () => {
  test('hashes with argon2id at 64 MiB, t=2, p=1', async () => {
    const hash = await hasher.hash(password(PLAIN));

    expect(hash).toStartWith('$argon2id$v=19$m=65536,t=2,p=1$');
  });

  test('salts every hash, so the same password never produces the same hash', async () => {
    const [first, second] = await Promise.all([hasher.hash(password(PLAIN)), hasher.hash(password(PLAIN))]);

    expect(first).not.toBe(second);
  });

  test('verifies a password against its own hash and rejects any other password', async () => {
    const hash = await hasher.hash(password(PLAIN));

    expect(await hasher.verify(hash, password(PLAIN))).toBe(true);
    expect(await hasher.verify(hash, password('another-Strong-pass-99'))).toBe(false);
  });

  test('still verifies hashes stored by the argon2 package before the migration', async () => {
    expect(await hasher.verify(LEGACY_HASH, password(PLAIN))).toBe(true);
    expect(await hasher.verify(LEGACY_HASH, password('another-Strong-pass-99'))).toBe(false);
  });

  test('returns false for a missing hash after doing comparable work', async () => {
    const real = await hasher.hash(password(PLAIN));
    await hasher.verify(null, password(PLAIN));

    const startedReal = performance.now();
    await hasher.verify(real, password('another-Strong-pass-99'));
    const realMs = performance.now() - startedReal;

    const startedMissing = performance.now();
    const missing = await hasher.verify(null, password(PLAIN));
    const missingMs = performance.now() - startedMissing;

    expect(missing).toBe(false);
    expect(missingMs).toBeGreaterThanOrEqual(realMs * 0.5);
  });
});
