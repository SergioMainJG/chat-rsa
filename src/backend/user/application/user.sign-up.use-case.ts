import type { NewUser, User } from '../domain/user.entity.ts';
import type { UserRepository } from '../domain/user.repository.ts';
import type { PasswordHasher, TokenIssuer } from '../domain/user.security.ts';
import type { AuthSession } from './user.session.ts';

import { type AppError, ConflictError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { type CredentialsInput, parseSignUpCredentials } from './user.credentials.ts';

export class SignUpUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
  ) {}

  async execute(input: CredentialsInput): Promise<Result<AuthSession, AppError>> {
    const credentials = parseSignUpCredentials(input);
    if (!credentials.ok) {
      return credentials;
    }

    const { name, password } = credentials.value;
    if (await this.users.findByName(name)) {
      return err(new ConflictError('User already exists'));
    }

    const passwordHash = await this.hasher.hash(password);
    const created = await this.create({ name, passwordHash });
    if (!created.ok) {
      return created;
    }
    return ok({ ...(await this.tokens.issue(created.value)), user: created.value.toPublic() });
  }

  /**
   * A concurrent sign-up can win the race after the pre-check; the datasource then throws
   * ConflictError. That is an expected failure, so it becomes a Result; anything else still
   * throws.
   */
  private async create(user: NewUser): Promise<Result<User, ConflictError>> {
    try {
      return ok(await this.users.create(user));
    } catch (error) {
      if (error instanceof ConflictError) {
        return err(error);
      }
      throw error;
    }
  }
}
