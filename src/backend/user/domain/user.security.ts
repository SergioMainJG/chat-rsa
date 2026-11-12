import type { User } from './user.entity.ts';
import type { Password, PasswordHash } from './user.value-objects.ts';

export abstract class PasswordHasher {
  abstract hash(password: Password): Promise<PasswordHash>;
  /**
   * With a `null` hash it still spends hashing time and returns false, so missing users are not
   * timeable.
   */
  abstract verify(hash: null | PasswordHash, password: Password): Promise<boolean>;
}

export abstract class TokenIssuer {
  abstract issue(user: User): Promise<string>;
}
