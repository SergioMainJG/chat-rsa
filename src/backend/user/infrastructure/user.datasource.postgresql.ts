import { SQL } from 'bun';

import { ConflictError } from '../../shared/domain/app.error.ts';
import { UserDatasource } from '../domain/user.datasource.ts';
import { type NewUser, User } from '../domain/user.entity.ts';
import { PasswordHash, UserId, UserName } from '../domain/user.value-objects.ts';

type UserRow = {
  readonly id: number;
  readonly name: string;
  readonly password: string;
};

const UNIQUE_VIOLATION = '23505';

export class PostgresUserDatasource extends UserDatasource {
  constructor(private readonly sql: SQL) {
    super();
  }

  override async create({ name, passwordHash }: NewUser): Promise<User> {
    try {
      const [row] = await this.sql<UserRow[]>`
        INSERT INTO users (name, password)
        VALUES (${name.value}, ${passwordHash})
        RETURNING id, name, password
      `;
      if (!row) {
        throw new Error('INSERT INTO users returned no row');
      }
      return toEntity(row);
    } catch (error) {
      if (error instanceof SQL.PostgresError && error.errno === UNIQUE_VIOLATION) {
        throw new ConflictError('User already exists');
      }
      throw error;
    }
  }

  override async findByName(name: UserName): Promise<null | User> {
    const [row] = await this.sql<UserRow[]>`
      SELECT id, name, password FROM users WHERE name = ${name.value}
    `;
    return row ? toEntity(row) : null;
  }
}

function toEntity(row: UserRow): User {
  return new User(
    UserId.restore(row.id),
    UserName.restore(row.name),
    PasswordHash.restore(row.password),
  );
}
