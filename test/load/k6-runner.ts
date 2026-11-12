// Shared by scripts/load.ts and the sabotage probes, so both run k6 the same way.
import { $ } from 'bun';

export const K6_IMAGE = 'docker.io/grafana/k6:2.4.0';
export const PROFILES = ['smoke', 'load', 'stress'] as const;
export type Profile = (typeof PROFILES)[number];

const LOAD_DIR = new URL('.', import.meta.url).pathname;
/** Base 36 of a millisecond timestamp, at least 8 characters, alphanumeric like user names. */
const RUN_ID_PATTERN = /^[0-9a-z]{8,}$/u;

export type K6Run = {
  readonly baseUrl: string;
  readonly profile: Profile;
  readonly runId: string;
  /** Host directory that receives `summary.json` (k6's `--summary-export`). */
  readonly summaryDir?: string;
};

export function newRunId(): string {
  return Date.now().toString(36);
}

/**
 * Exact pattern of the user names one run creates: `load<runId>p<n>` (sign-in pool) and
 * `load<runId>u<n>` (sign-ups). Anchored, so it never matches `loader`, `loadbalancer` or the users
 * of another run. Throws on a malformed runId instead of widening the match.
 */
export function runUserPattern(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Refusing to build a delete pattern for runId "${runId}"`);
  }
  return `^load${runId}[pu][0-9]+$`;
}

/** Runs auth.load.ts from the pinned image; resolves with k6's exit code (99 = threshold failed). */
export async function runK6({ baseUrl, profile, runId, summaryDir }: K6Run): Promise<number> {
  const summaryMount = summaryDir === undefined ? [] : ['-v', `${summaryDir}:/results:Z`];
  const summaryFlag = summaryDir === undefined ? [] : ['--summary-export', '/results/summary.json'];
  // --network host: the container reaches the server on the host's localhost.
  const { exitCode } = await $`podman run --rm --network host \
    -v ${LOAD_DIR}:/scripts:ro,Z ${summaryMount} \
    -e BASE_URL=${baseUrl} -e RUN_ID=${runId} -e PROFILE=${profile} \
    ${K6_IMAGE} run --quiet ${summaryFlag} /scripts/auth.load.ts`.nothrow();
  return exitCode;
}
