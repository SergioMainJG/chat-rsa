import type { RedisClient } from 'bun';

import { SessionRevocations } from '../domain/user.security.ts';

export const REVOKED_SESSION_KEY_PREFIX = 'revoked-session:';

/**
 * Signed-out sessions in Valkey, keyed `revoked-session:<sessionId>`. An entry lives for one token
 * lifetime: every token of the session was issued before the sign-out (refresh is refused after
 * it), so by then all of them have expired on their own.
 */
export class ValkeySessionRevocations extends SessionRevocations {
  constructor(
    private readonly client: RedisClient,
    private readonly ttlSeconds: number,
  ) {
    super();
  }

  override async isRevoked(sessionId: string): Promise<boolean> {
    const reply: unknown = await this.client.send('EXISTS', [keyOf(sessionId)]);
    return reply !== 0;
  }

  override async revoke(sessionId: string): Promise<void> {
    await this.client.send('SET', [keyOf(sessionId), '1', 'EX', String(this.ttlSeconds)]);
  }
}

function keyOf(sessionId: string): string {
  return `${REVOKED_SESSION_KEY_PREFIX}${sessionId}`;
}
