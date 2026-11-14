// Deletes what one load run created, in one transaction so a failure changes nothing.
import type { RedisClient, SQL } from 'bun';

import { RATE_LIMIT_KEY_PREFIX } from '../../src/backend/shared/rate-limit/rate-limit.valkey.ts';
import { runUserPattern } from './k6-runner.ts';

export type RemovedRunData = {
  readonly rooms: number;
  readonly users: number;
};

/**
 * Removes the run's users and everything that keeps them referenced, in this order: rooms they
 * created and rooms whose members all belong to the run (cascading members, sender-key envelopes
 * and messages; deleting the room itself never trips `rooms_min_members`), then their messages in
 * other people's rooms (`messages.sender_id` has no cascade), then the users (cascading memberships
 * and identity keys).
 *
 * A run user who is one of only two members of someone else's room makes the deferred
 * `rooms_min_members` check fail at COMMIT: the cleanup then throws and deletes nothing, rather
 * than deleting a room that is not the run's.
 */
export async function deleteRunData(sql: SQL, runId: string): Promise<RemovedRunData> {
  const pattern = runUserPattern(runId);
  return sql.begin(async (tx) => {
    const deletedRooms = await tx`
      WITH run_users AS (SELECT id FROM users WHERE name ~ ${pattern})
      DELETE FROM rooms r
      WHERE r.created_by IN (SELECT id FROM run_users)
         OR (EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id IN (SELECT id FROM run_users))
             AND NOT EXISTS (
               SELECT 1 FROM room_members m
               WHERE m.room_id = r.id AND m.user_id NOT IN (SELECT id FROM run_users)
             ))
    `;
    await tx`
      DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE name ~ ${pattern})
    `;
    const deletedUsers = await tx`DELETE FROM users WHERE name ~ ${pattern}`;
    return { rooms: deletedRooms.count, users: deletedUsers.count };
  });
}

/** Addresses a k6 container on `--network host` reaches a local server from. */
export const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'] as const;

/** Ids of the users a run created, read before `deleteRunData` removes them. */
export async function runUserIds(sql: SQL, runId: string): Promise<number[]> {
  const rows = await sql<
    Array<{ id: number }>
  >`SELECT id FROM users WHERE name ~ ${runUserPattern(runId)}`;
  return rows.map((row) => row.id);
}

/**
 * Refills the token buckets a local load run spends (`rl:ip:<loopback>` and `rl:user:<id>` of its
 * own users), so the next run does not start against an exhausted bucket. Other keys stay.
 */
export async function resetRateLimits(
  client: RedisClient,
  userIds: readonly number[],
): Promise<void> {
  const keys = [
    ...LOOPBACK_ADDRESSES.map((address) => `${RATE_LIMIT_KEY_PREFIX}ip:${address}`),
    ...userIds.map((id) => `${RATE_LIMIT_KEY_PREFIX}user:${id}`),
  ];
  await client.send('DEL', keys);
}
