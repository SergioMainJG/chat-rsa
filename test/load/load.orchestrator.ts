// Orchestration behind `bun run test:load`: pre-flight, one k6 run per suite under a shared runId,
// Ctrl+C handling, and a cleanup that always runs. scripts/load.ts only wires the real adapters.
import { $ } from 'bun';

import type { RemovedRunData } from './load.cleanup.ts';

import { type K6Run, type Profile, PROFILES, runUserPattern, type Script } from './k6-runner.ts';

export type LoadDependencies = {
  readonly cleanup: (runId: string) => Promise<RemovedRunData>;
  readonly log: {
    readonly error: (message: string) => void;
    readonly info: (message: string) => void;
  };
  readonly newRunId: () => string;
  /** Registers the handler for SIGINT and SIGTERM; returns the function that removes it. */
  readonly onSignal: (handler: (signal: Signal) => void) => () => void;
  /** Null when the server, PostgreSQL and Valkey answer; otherwise what is down. */
  readonly preflight: () => Promise<null | string>;
  /** Refills the loopback IP buckets, the given users' buckets and the run's sign-in buckets. */
  readonly resetRateLimits: (runId: string, userIds: readonly number[]) => Promise<void>;
  readonly runK6: (run: K6Run) => Promise<number>;
  readonly runUserIds: (runId: string) => Promise<number[]>;
  readonly stopContainer: (name: string) => Promise<void>;
};

export type LoadPlan = {
  readonly baseUrl: string;
  readonly profile: Profile;
  readonly scripts: readonly Script[];
};

export type Signal = 'SIGINT' | 'SIGTERM';

const SUITES: Readonly<Record<string, readonly Script[]>> = {
  all: ['auth.load.ts', 'messages.load.ts'],
  auth: ['auth.load.ts'],
  messages: ['messages.load.ts'],
};
/** Shell convention: 128 + signal number. */
const SIGNAL_EXIT: Readonly<Record<Signal, number>> = { SIGINT: 130, SIGTERM: 143 };
export const PREFLIGHT_TIMEOUT_MS = 5000;

/** `[profile] [suite]`, defaulting to `smoke all`; null for anything else. */
export function parseLoadArgs(
  argv: readonly string[],
): null | { readonly profile: Profile; readonly scripts: readonly Script[] } {
  const [rawProfile = 'smoke', suite = 'all', ...rest] = argv;
  const profile = PROFILES.find((candidate) => candidate === rawProfile);
  const scripts = SUITES[suite];
  return profile === undefined || scripts === undefined || rest.length > 0
    ? null
    : { profile, scripts };
}

export function usage(): string {
  return `Usage: bun run test:load [${PROFILES.join('|')}] [${Object.keys(SUITES).join('|')}]`;
}

/** One container per run and suite, e.g. `k6-<runId>-auth`. */
export function containerName(runId: string, script: Script): string {
  return `k6-${runId}-${script.replace(/\.load\.ts$/u, '')}`;
}

/** A server that answers `GET /` with a 2xx within the timeout; a hanging socket counts as down. */
export async function reachable(
  baseUrl: string,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<boolean> {
  return fetch(baseUrl, { signal: AbortSignal.timeout(timeoutMs) }).then(
    (response) => response.ok,
    () => false,
  );
}

/** True when `pending` resolves within the timeout; the timer is cleared as soon as it settles. */
export async function stopContainer(name: string): Promise<void> {
  await $`podman stop --time 2 ${name}`.quiet().nothrow();
}

export async function withTimeout(
  pending: Promise<unknown>,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<boolean> {
  const expired = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    expired.resolve(false);
  }, timeoutMs);
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => false,
      ),
      expired.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the plan and returns the process exit code; the cleanup runs whatever happens to k6. */
export async function runLoad(plan: LoadPlan, deps: LoadDependencies): Promise<number> {
  const down = await deps.preflight();
  if (down !== null) {
    deps.log.error(down);
    return 1;
  }
  const runId = deps.newRunId();
  // Built before k6 starts: a malformed runId aborts here instead of widening the delete later.
  const pattern = runUserPattern(runId);
  // Written by the signal handler, so kept in objects rather than narrowed locals.
  const signals: { interrupted: null | Signal } = { interrupted: null };
  // A call, not a property read: TypeScript would keep a narrowed `interrupted` across the awaits.
  const interrupted = (): boolean => signals.interrupted !== null;
  const running: { container: null | string } = { container: null };
  const removeHandler = deps.onSignal((signal) => {
    signals.interrupted = signal;
    if (running.container !== null) {
      void deps.stopContainer(running.container);
    }
  });
  const codes: number[] = [];
  try {
    for (const script of plan.scripts) {
      // A signal during the previous suite: no reset and no k6 for this one.
      if (interrupted()) {
        break;
      }
      // Each suite starts with full buckets, so one suite's traffic cannot fail the next one.
      // eslint-disable-next-line no-await-in-loop
      await deps.resetRateLimits(runId, []);
      // Checked after the reset too: a signal that arrives during it must not start k6.
      if (interrupted()) {
        break;
      }
      const name = containerName(runId, script);
      running.container = name;
      // eslint-disable-next-line no-await-in-loop
      const code = await deps.runK6({
        baseUrl: plan.baseUrl,
        name,
        profile: plan.profile,
        runId,
        script,
      });
      running.container = null;
      codes.push(code);
    }
  } catch (error) {
    deps.log.error(error instanceof Error ? error.message : String(error));
    codes.push(1);
  }
  // k6 exits 99 when a threshold fails; keep the first failure so CI and scripts can react to it.
  const k6Code = codes.find((code) => code !== 0) ?? 0;
  try {
    const cleaned = await cleanUp(runId, pattern, deps);
    if (signals.interrupted !== null) {
      return SIGNAL_EXIT[signals.interrupted];
    }
    // A passing run whose data could not be removed still fails.
    return k6Code === 0 && !cleaned ? 1 : k6Code;
  } finally {
    removeHandler();
  }
}

/**
 * True when the run's data is gone and its buckets are full again. The buckets are refilled even
 * when the delete fails, so the next run does not start against them. A failure is logged, never
 * thrown, so it cannot hide k6's code.
 */
async function cleanUp(runId: string, pattern: string, deps: LoadDependencies): Promise<boolean> {
  let userIds: readonly number[] = [];
  let removed: null | RemovedRunData = null;
  try {
    userIds = await deps.runUserIds(runId);
    removed = await deps.cleanup(runId);
  } catch (error) {
    logCleanupFailure(deps, error);
  }
  try {
    await deps.resetRateLimits(runId, userIds);
  } catch (error) {
    logCleanupFailure(deps, error);
    return false;
  }
  if (removed === null) {
    return false;
  }
  deps.log.info(
    `Removed ${removed.users} load-test users and ${removed.rooms} rooms (pattern ${pattern}).`,
  );
  return true;
}

function logCleanupFailure(deps: LoadDependencies, error: unknown): void {
  deps.log.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
}
