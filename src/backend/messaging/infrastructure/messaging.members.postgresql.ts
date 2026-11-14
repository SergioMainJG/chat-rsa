import type { SQL } from 'bun';

import { UserId } from '../../user/domain/user.value-objects.ts';
import { MemberDirectory } from '../domain/messaging.repository.ts';

/** Reads display names from `users`; callers pass only ids of a room the actor belongs to. */
export class PostgresMemberDirectory extends MemberDirectory {
  constructor(private readonly sql: SQL) {
    super();
  }

  override async names(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.sql<Array<{ id: number; name: string }>>`
      SELECT id, name FROM users WHERE id IN ${this.sql(userIds)} ORDER BY id
    `;
    return new Map(rows.map((row) => [UserId.restore(row.id), row.name]));
  }
}
