import type { RedisClient } from 'bun';

import type { BucketPolicy, TakeOutcome } from '../domain/token-bucket.ts';

import { RateLimiter } from './rate-limit.port.ts';

export const RATE_LIMIT_KEY_PREFIX = 'rl:';

/**
 * `takeToken` in Lua, so the read-refill-take-write step is atomic per key. A missing key is a full
 * bucket. Numbers travel as `%.17g` strings because Valkey truncates Lua numbers to integers and
 * `tostring` keeps only 14 digits, and the math must match `takeToken` exactly.
 */
const TAKE_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local stored = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(stored[1])
local updated = tonumber(stored[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
tokens = math.min(capacity, tokens + (math.max(0, now - updated) / 1000) * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.max(1, math.ceil((cost - tokens) / refill))
end
local text = string.format('%.17g', tokens)
redis.call('HSET', KEYS[1], 'tokens', text, 'updatedAt', string.format('%.17g', now))
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, retry, text }
`;

/**
 * Shared token buckets in Valkey, keyed `rl:<key>`. The key expires once the bucket would be full
 * again, and a missing key is a full bucket, so expiry never changes an outcome.
 */
export class ValkeyRateLimiter extends RateLimiter {
  constructor(
    private readonly client: RedisClient,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  override async take(key: string, policy: BucketPolicy): Promise<TakeOutcome> {
    const nowMs = this.now();
    const ttlMs = Math.max(1000, Math.ceil((policy.capacity / policy.refillPerSecond) * 1000));
    const reply: unknown = await this.client.send('EVAL', [
      TAKE_SCRIPT,
      '1',
      `${RATE_LIMIT_KEY_PREFIX}${key}`,
      String(policy.capacity),
      String(policy.refillPerSecond),
      String(nowMs),
      '1',
      String(ttlMs),
    ]);
    return outcomeOf(reply, nowMs);
  }
}

function outcomeOf(reply: unknown, nowMs: number): TakeOutcome {
  if (!Array.isArray(reply) || reply.length !== 3) {
    throw new Error('Unexpected rate limiter reply from Valkey');
  }
  const items: readonly unknown[] = reply;
  const [allowed, retryAfterSeconds, tokens] = items;
  if (
    typeof allowed !== 'number' ||
    typeof retryAfterSeconds !== 'number' ||
    typeof tokens !== 'string'
  ) {
    throw new TypeError('Unexpected rate limiter reply from Valkey');
  }
  return {
    allowed: allowed === 1,
    retryAfterSeconds,
    state: { tokens: Number(tokens), updatedAt: nowMs },
  };
}
