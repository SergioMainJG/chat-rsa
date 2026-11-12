import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { PasswordHash, UserId, UserName } from './user.value-objects.ts';

export type NewUser = {
  readonly name: UserName;
  readonly passwordHash: PasswordHash;
};

export class User {
  constructor(
    readonly id: UserId,
    readonly name: UserName,
    readonly passwordHash: PasswordHash,
  ) {}

  /** Shape safe to send to clients: never includes the password hash. */
  toPublic(): PublicUser {
    return { id: this.id, name: this.name.value };
  }
}
