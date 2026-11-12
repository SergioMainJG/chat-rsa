import { PasswordHasher } from '../domain/user.security.ts';
import { type Password, PasswordHash } from '../domain/user.value-objects.ts';

/**
 * Argon2id through Bun's native `Bun.password` (no npm dependency). The cost is pinned instead of
 * relying on Bun's defaults: 64 MiB and 2 passes. Bun always uses one lane (p=1).
 * `Bun.password.verify` reads the parameters from the stored hash, so hashes made earlier with
 * different settings (the `argon2` package used t=3, p=4) keep verifying.
 */
const ARGON2_OPTIONS = { algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 } as const;

export class Argon2PasswordHasher extends PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  override async hash(password: Password): Promise<PasswordHash> {
    return PasswordHash.restore(await Bun.password.hash(password.value, ARGON2_OPTIONS));
  }

  override async verify(storedHash: null | PasswordHash, password: Password): Promise<boolean> {
    if (storedHash === null) {
      // Unknown user: still pay for one verify, so the response time does not reveal it.
      this.dummyHash ??= Bun.password.hash('timing-equalizer', ARGON2_OPTIONS);
      await Bun.password.verify(password.value, await this.dummyHash);
      return false;
    }
    return Bun.password.verify(password.value, storedHash);
  }
}
