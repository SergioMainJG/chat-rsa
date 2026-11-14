// Shared by scripts/load.ts and the sabotage probes, so both run k6 the same way.
import { $ } from 'bun';

export const K6_IMAGE = 'docker.io/grafana/k6:2.4.0';
export const PROFILES = ['smoke', 'load', 'stress'] as const;
export type Profile = (typeof PROFILES)[number];
/** K6 scripts in test/load, one per feature suite. */
export const SCRIPTS = ['auth.load.ts', 'messages.load.ts'] as const;
export type Script = (typeof SCRIPTS)[number];

const LOAD_DIR = new URL('.', import.meta.url).pathname;
/** Base 36 time plus random characters, at least 8 characters, alphanumeric like user names. */
const RUN_ID_PATTERN = /^[0-9a-z]{8,}$/u;

export type K6Run = {
  readonly baseUrl: string;
  /** Podman container name, so an interrupted run can stop it with `podman stop <name>`. */
  readonly name?: string;
  readonly profile: Profile;
  readonly runId: string;
  /** Defaults to `auth.load.ts`. */
  readonly script?: Script;
  /** Host directory that receives `summary.json` (k6's `--summary-export`). */
  readonly summaryDir?: string;
};

/** Random base 36 characters appended to the time, so runs started in the same millisecond differ. */
const RUN_ID_ENTROPY = 8;

export function newRunId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(RUN_ID_ENTROPY)), (byte) =>
    (byte % 36).toString(36),
  ).join('');
  return `${Date.now().toString(36)}${random}`;
}

/**
 * Exact pattern of the user names one run creates: `load<runId>p<n>` (sign-in pool),
 * `load<runId>u<n>` (sign-ups) and `load<runId>m<n>` (messaging users). Anchored, so it never
 * matches `loader`, `loadbalancer` or the users of another run. Throws on a malformed runId instead
 * of widening the match.
 */
export function runUserPattern(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Refusing to build a delete pattern for runId "${runId}"`);
  }
  return `^load${runId}[pum][0-9]+$`;
}

/** Runs one k6 script from the pinned image; resolves with k6's exit code (99 = threshold failed). */
export async function runK6({
  baseUrl,
  name,
  profile,
  runId,
  script = 'auth.load.ts',
  summaryDir,
}: K6Run): Promise<number> {
  const summaryMount = summaryDir === undefined ? [] : ['-v', `${summaryDir}:/results:Z`];
  const summaryFlag = summaryDir === undefined ? [] : ['--summary-export', '/results/summary.json'];
  const nameFlag = name === undefined ? [] : ['--name', name];
  // --network host: the container reaches the server on the host's localhost.
  const { exitCode } = await $`podman run --rm ${nameFlag} --network host \
    -v ${LOAD_DIR}:/scripts:ro,Z ${summaryMount} \
    -e BASE_URL=${baseUrl} -e RUN_ID=${runId} -e PROFILE=${profile} \
    ${K6_IMAGE} run --quiet ${summaryFlag} /scripts/${script}`.nothrow();
  return exitCode;
}
