import { ConflictError } from '../../shared/domain/app.error.ts';
import { UserDatasource } from '../domain/user.datasource.ts';
import { type NewUser, User } from '../domain/user.entity.ts';
import {
  type IssuedToken,
  PasswordHasher,
  SessionRevocations,
  TokenIssuer,
} from '../domain/user.security.ts';
import {
  type Password,
  PasswordHash,
  UserId,
  type UserName,
} from '../domain/user.value-objects.ts';

/** In-memory datasource for unit tests; honours the same name-uniqueness rule as Postgres. */
export class InMemoryUserDatasource extends UserDatasource {
  readonly users: User[] = [];

  override async create({ name, passwordHash }: NewUser): Promise<User> {
    if (this.users.some((existing) => existing.name.equals(name))) {
      throw new ConflictError('User already exists');
    }
    const user = new User(UserId.restore(this.users.length + 1), name, passwordHash);
    this.users.push(user);
    return user;
  }

  override async findByName(name: UserName): Promise<null | User> {
    return this.users.find((user) => user.name.equals(name)) ?? null;
  }
}

/** Simulates losing a race: the pre-check never sees the row another request just inserted. */
export class StaleReadUserDatasource extends InMemoryUserDatasource {
  override async findByName(): Promise<null | User> {
    return null;
  }
}

/** Deterministic hasher: `hashed:<password>`. Records verify calls to assert timing behaviour. */
export class FakePasswordHasher extends PasswordHasher {
  readonly verified: Array<null | PasswordHash> = [];

  override async hash(password: Password): Promise<PasswordHash> {
    return PasswordHash.restore(`hashed:${password.value}`);
  }

  override async verify(hash: null | PasswordHash, password: Password): Promise<boolean> {
    this.verified.push(hash);
    return hash === `hashed:${password.value}`;
  }
}

export const FAKE_EXPIRES_AT = new Date('2030-01-01T00:00:00.000Z');

export class FakeTokenIssuer extends TokenIssuer {
  override async issue(user: User): Promise<IssuedToken> {
    return { expiresAt: FAKE_EXPIRES_AT, token: `token-for-${user.id}` };
  }
}

/** Revoked session ids in memory; `failing` makes every call throw, as an unreachable Valkey would. */
export class InMemorySessionRevocations extends SessionRevocations {
  failing = false;
  readonly revoked = new Set<string>();

  override async isRevoked(sessionId: string): Promise<boolean> {
    if (this.failing) {
      throw new Error('revocations unavailable');
    }
    return this.revoked.has(sessionId);
  }

  override async revoke(sessionId: string): Promise<void> {
    if (this.failing) {
      throw new Error('revocations unavailable');
    }
    this.revoked.add(sessionId);
  }
}

export const STRONG_PASSWORD = 'correct-Horse-battery-st4ple';
