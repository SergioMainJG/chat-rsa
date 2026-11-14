import type { BucketPolicy, TakeOutcome } from '../domain/token-bucket.ts';

/** Takes one token from the bucket named `key`; every adapter applies `takeToken`'s math. */
export abstract class RateLimiter {
  abstract take(key: string, policy: BucketPolicy): Promise<TakeOutcome>;
}
