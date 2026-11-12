import type { NewUser, User } from './user.entity.ts';
import type { UserName } from './user.value-objects.ts';

/** What use cases depend on; implementations delegate to a `UserDatasource`. */
export abstract class UserRepository {
  abstract create(user: NewUser): Promise<User>;
  abstract findByName(name: UserName): Promise<null | User>;
}
