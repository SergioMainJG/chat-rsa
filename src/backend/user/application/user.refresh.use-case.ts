import type { UserRepository } from '../domain/user.repository.ts';
import type { TokenIssuer, TokenVerifier } from '../domain/user.security.ts';
import type { AuthSession } from './user.session.ts';

import { type AppError, UnauthorizedError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { UserName } from '../domain/user.value-objects.ts';

export type RefreshPolicy = {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  /** A session older than this (since its sign-in, `sst`) is not refreshed any more. */
  readonly sessionMaxAgeSeconds: number;
};

/**
 * Trades a valid, unexpired token for a fresh one in the same session. The user must still exist
 * with the same id, so the token of a deleted account, or of a name that now belongs to someone
 * else, is refused, and so is a session past its absolute lifetime.
 */
export class RefreshUseCase {
  private readonly now: () => number;

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly users: UserRepository,
    private readonly tokens: TokenIssuer,
    private readonly policy: RefreshPolicy,
    /** Tells whatever else holds the session, such as its sockets, about the new expiry. */
    private readonly onRefreshed: (sessionId: string, expiresAt: Date) => void = () => {
      // Nothing else to tell by default.
    },
  ) {
    this.now = policy.now ?? Date.now;
  }

  async execute(token: string): Promise<Result<AuthSession, AppError>> {
    const refused = err(new UnauthorizedError('Invalid or expired token'));
    const claims = await this.verifier.verify(token);
    const name = claims ? UserName.create(claims.name) : null;
    if (!claims || !name?.ok) {
      return refused;
    }
    const ageMs = this.now() - claims.sessionStartedAt.getTime();
    if (ageMs > this.policy.sessionMaxAgeSeconds * 1000) {
      return refused;
    }
    const user = await this.users.findByName(name.value);
    if (user?.id !== claims.userId) {
      return refused;
    }
    const issued = await this.tokens.issue(user, {
      id: claims.sessionId,
      startedAt: claims.sessionStartedAt,
    });
    this.onRefreshed(claims.sessionId, issued.expiresAt);
    return ok({ ...issued, user: user.toPublic() });
  }
}
