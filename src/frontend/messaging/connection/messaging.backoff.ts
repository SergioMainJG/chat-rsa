export type BackoffOptions = {
  /** Ceiling of the first attempt; attempt n has a ceiling of `baseMs * 2^n`. */
  readonly baseMs?: number;
  /** No delay ever exceeds this, whatever the attempt. */
  readonly capMs?: number;
  /** A uniform source in [0, 1), such as `Math.random`; injected so tests are deterministic. */
  readonly random: () => number;
};

/**
 * Delay before reconnection attempt `attempt` (0 for the first retry), in milliseconds.
 *
 * Strategy: "full jitter". The ceiling grows as `baseMs * 2^attempt` (1 s, 2 s, 4 s, …) up to
 * `capMs`, and the delay is a uniform random value between 0 and that ceiling. Spreading retries
 * over the whole window keeps many clients that lost the server at the same moment (a deploy, a
 * SIGTERM drain) from reconnecting in lockstep. A `random()` of 1 still yields the cap, never
 * more.
 */
export function backoffDelay(
  attempt: number,
  { baseMs = 1000, capMs = 30_000, random }: BackoffOptions,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.min(capMs, Math.floor(random() * ceiling));
}
