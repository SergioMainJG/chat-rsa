import type { UserDatasource } from '../domain/user.datasource.ts';
import type { NewUser, User } from '../domain/user.entity.ts';
import type { UserName } from '../domain/user.value-objects.ts';

import { UserRepository } from '../domain/user.repository.ts';

/** Receives its datasource by injection, so swapping storage never touches use cases. */
export class UserRepositoryImpl extends UserRepository {
  constructor(private readonly datasource: UserDatasource) {
    super();
  }

  override async create(user: NewUser): Promise<User> {
    return this.datasource.create(user);
  }

  override async findByName(name: UserName): Promise<null | User> {
    return this.datasource.findByName(name);
  }
}
