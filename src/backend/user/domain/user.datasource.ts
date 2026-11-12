import type { NewUser, User } from './user.entity.ts';
import type { UserName } from './user.value-objects.ts';

/** Talks to a concrete storage engine. Throws `ConflictError` when the name is taken. */
export abstract class UserDatasource {
  abstract create(user: NewUser): Promise<User>;
  abstract findByName(name: UserName): Promise<null | User>;
}
