import type { AuthResponse } from '../../../shared/contracts/auth.contract.ts';
import type { UserRepository } from '../domain/user.repository.ts';
import type { TokenIssuer, TokenVerifier } from '../domain/user.security.ts';

import { type AppError, UnauthorizedError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { UserName } from '../domain/user.value-objects.ts';

/**
 * Trades a valid, unexpired token for a fresh one. The user must still exist with the same id, so
 * the token of a deleted account, or of a name that now belongs to someone else, is refused.
 */
export class RefreshUseCase {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly users: UserRepository,
    private readonly tokens: TokenIssuer,
  ) {}

  async execute(token: string): Promise<Result<AuthResponse, AppError>> {
    const refused = err(new UnauthorizedError('Invalid or expired token'));
    const claims = await this.verifier.verify(token);
    const name = claims ? UserName.create(claims.name) : null;
    if (!claims || !name?.ok) {
      return refused;
    }
    const user = await this.users.findByName(name.value);
    if (user?.id !== claims.userId) {
      return refused;
    }
    return ok({ token: await this.tokens.issue(user, claims.sessionId), user: user.toPublic() });
  }
}
