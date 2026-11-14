import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { UserRepository } from '../domain/user.repository.ts';

import { type AppError, NotFoundError, ValidationError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { UserName } from '../domain/user.value-objects.ts';

/** Finds a user by name, so a room member can add people they know by name. */
export class LookupUserUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(rawName: unknown): Promise<Result<PublicUser, AppError>> {
    const name = UserName.create(rawName);
    if (!name.ok) {
      return err(new ValidationError([name.error]));
    }
    const user = await this.users.findByName(name.value);
    return user ? ok(user.toPublic()) : err(new NotFoundError('User not found'));
  }
}
