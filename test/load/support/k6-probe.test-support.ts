// Runs a real k6 script against a fake server and collects what the sabotage probes assert on.
import { afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newRunId, type Profile, runK6, type Script } from '../k6-runner.ts';

export const K6_TIMEOUT_MS = 180_000;
export const THRESHOLD_FAILED = 99;
export const SCRIPT_EXCEPTION = 107;

export type ProbeOptions = {
  /** Podman container name (see `stopContainer`). */
  readonly name?: string;
  readonly profile?: Profile;
  /** Reuse one run id across runs, as a retried run does. */
  readonly runId?: string;
  readonly script?: Script;
};

export type ProbeRun = {
  readonly exitCode: number;
  readonly summary: null | Summary;
};

export type ProbeServer = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
};

export type Summary = {
  readonly metrics: Readonly<
    Record<
      string,
      {
        readonly count?: number;
        readonly thresholds?: Readonly<Record<string, boolean>>;
      }
    >
  >;
  readonly root_group: {
    readonly checks: Readonly<Record<string, { readonly fails: number; readonly passes: number }>>;
  };
};

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** True when any threshold of the metric was crossed (k6 marks a crossed threshold `true`). */
export function crossed(run: ProbeRun, metric: string): boolean {
  return Object.values(run.summary?.metrics[metric]?.thresholds ?? {}).some(Boolean);
}

export function failedChecks(run: ProbeRun): string[] {
  return Object.entries(run.summary?.root_group.checks ?? {})
    .filter(([, check]) => check.fails > 0)
    .map(([name]) => name);
}

/** Runs k6 once against a server that is already listening; the caller stops it. */
export async function runK6Against(
  server: ProbeServer,
  options: ProbeOptions = {},
): Promise<ProbeRun> {
  const summaryDir = mkdtempSync(join(tmpdir(), 'k6-probe-'));
  scratchDirs.push(summaryDir);
  // The k6 image runs as an unprivileged user that must be able to write the summary.
  chmodSync(summaryDir, 0o777);
  const exitCode = await runK6({
    baseUrl: server.baseUrl,
    ...(options.name !== undefined && { name: options.name }),
    profile: options.profile ?? 'smoke',
    runId: options.runId ?? newRunId(),
    script: options.script ?? 'auth.load.ts',
    summaryDir,
  });
  return { exitCode, summary: summaryIn(summaryDir) };
}

function summaryIn(dir: string): null | Summary {
  try {
    const parsed: Summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    return parsed;
  } catch {
    return null;
  }
}
