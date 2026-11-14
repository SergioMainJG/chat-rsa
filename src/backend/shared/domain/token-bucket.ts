/** Token bucket: `capacity` is the burst, `refillPerSecond` the sustained rate. */
export type BucketPolicy = {
  readonly capacity: number;
  readonly refillPerSecond: number;
};

export type BucketState = {
  readonly tokens: number;
  readonly updatedAt: number;
};

export type TakeOutcome = {
  readonly allowed: boolean;
  /** Whole seconds until one token is available; 0 when allowed. */
  readonly retryAfterSeconds: number;
  readonly state: BucketState;
};

/**
 * Pure token-bucket step shared by every limiter (HTTP and WebSocket frames). A missing state is a
 * full bucket; a clock that moves backwards adds nothing.
 */
export function takeToken(
  state: BucketState | null,
  policy: BucketPolicy,
  nowMs: number,
  cost = 1,
): TakeOutcome {
  const previous = state ?? { tokens: policy.capacity, updatedAt: nowMs };
  const elapsedSeconds = Math.max(0, nowMs - previous.updatedAt) / 1000;
  const tokens = Math.min(
    policy.capacity,
    previous.tokens + elapsedSeconds * policy.refillPerSecond,
  );
  if (tokens >= cost) {
    return {
      allowed: true,
      retryAfterSeconds: 0,
      state: { tokens: tokens - cost, updatedAt: nowMs },
    };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((cost - tokens) / policy.refillPerSecond)),
    state: { tokens, updatedAt: nowMs },
  };
}
