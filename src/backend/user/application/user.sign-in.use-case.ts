import type { BucketPolicy } from '../../shared/domain/token-bucket.ts';
import type { RateLimiter } from '../../shared/rate-limit/rate-limit.port.ts';
import type { UserRepository } from '../domain/user.repository.ts';
import type { PasswordHasher, TokenIssuer } from '../domain/user.security.ts';
import type { AuthSession } from './user.session.ts';

import {
  type AppError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { type CredentialsInput, parseSignInCredentials } from './user.credentials.ts';

/** One token bucket per account name, so guessing one account's password is slow from any IP. */
export type SignInThrottle = {
  readonly limiter: RateLimiter;
  readonly policy: BucketPolicy;
};

export class SignInUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
    private readonly throttle: SignInThrottle,
  ) {}

  async execute(input: CredentialsInput): Promise<Result<AuthSession, AppError>> {
    const credentials = parseSignInCredentials(input);
    if (!credentials.ok) {
      return credentials;
    }

    const { name, password } = credentials.value;
    // Spent before the hash is checked, for known and unknown names alike, so the throttle says
    // nothing about which names exist. Someone can slow down sign-in for a known name (accepted).
    const attempt = await this.throttle.limiter.take(`signin:${name.value}`, this.throttle.policy);
    if (!attempt.allowed) {
      return err(new TooManyRequestsError('Too many sign-in attempts', attempt.retryAfterSeconds));
    }

    const user = await this.users.findByName(name);
    const valid = await this.hasher.verify(user?.passwordHash ?? null, password);

    // Same answer for an unknown name and a wrong password, so names cannot be enumerated.
    if (!user || !valid) {
      return err(new UnauthorizedError('Invalid credentials'));
    }
    return ok({ ...(await this.tokens.issue(user)), user: user.toPublic() });
  }
}
