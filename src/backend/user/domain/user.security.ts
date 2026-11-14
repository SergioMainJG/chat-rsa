import type { User } from './user.entity.ts';
import type { Password, PasswordHash, UserId } from './user.value-objects.ts';

/** What a verified sign-in token proves. */
export type TokenClaims = {
  readonly expiresAt: Date;
  readonly name: string;
  /** One sign-in: kept by every refresh, revoked as a whole by sign-out. */
  readonly sessionId: string;
  readonly userId: UserId;
};

export abstract class PasswordHasher {
  abstract hash(password: Password): Promise<PasswordHash>;
  /**
   * With a `null` hash it still spends hashing time and returns false, so missing users are not
   * timeable.
   */
  abstract verify(hash: null | PasswordHash, password: Password): Promise<boolean>;
}

/** Signed-out sessions. A revoked session's tokens are refused everywhere, refresh included. */
export abstract class SessionRevocations {
  abstract isRevoked(sessionId: string): Promise<boolean>;
  abstract revoke(sessionId: string): Promise<void>;
}

export abstract class TokenIssuer {
  /** Signs a token for `user`; without `sessionId` it starts a new session. */
  abstract issue(user: User, sessionId?: string): Promise<string>;
}

export abstract class TokenVerifier {
  /** The claims of a valid, unexpired token; null for anything else. Never throws. */
  abstract verify(token: string): Promise<null | TokenClaims>;
}
