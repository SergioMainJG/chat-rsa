import type { AuthResponse } from '../../../shared/contracts/auth.contract.ts';
import type { UserRepository } from '../domain/user.repository.ts';
import type { PasswordHasher, TokenIssuer } from '../domain/user.security.ts';

import { type AppError, UnauthorizedError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { type CredentialsInput, parseSignInCredentials } from './user.credentials.ts';

export class SignInUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
  ) {}

  async execute(input: CredentialsInput): Promise<Result<AuthResponse, AppError>> {
    const credentials = parseSignInCredentials(input);
    if (!credentials.ok) {
      return credentials;
    }

    const { name, password } = credentials.value;
    const user = await this.users.findByName(name);
    const valid = await this.hasher.verify(user?.passwordHash ?? null, password);

    // Same answer for an unknown name and a wrong password, so names cannot be enumerated.
    if (!user || !valid) {
      return err(new UnauthorizedError('Invalid credentials'));
    }
    return ok({ token: await this.tokens.issue(user), user: user.toPublic() });
  }
}
