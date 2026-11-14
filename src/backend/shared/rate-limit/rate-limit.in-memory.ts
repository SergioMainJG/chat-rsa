import {
  type BucketPolicy,
  type BucketState,
  type TakeOutcome,
  takeToken,
} from '../domain/token-bucket.ts';
import { RateLimiter } from './rate-limit.port.ts';

/**
 * Process-local limiter for unit tests. Buckets are never evicted, so it is not meant for
 * production traffic; `ValkeyRateLimiter` keeps a TTL per key instead.
 */
export class InMemoryRateLimiter extends RateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory adapter of an async port
  override async take(key: string, policy: BucketPolicy): Promise<TakeOutcome> {
    const outcome = takeToken(this.buckets.get(key) ?? null, policy, this.now());
    this.buckets.set(key, outcome.state);
    return outcome;
  }
}
