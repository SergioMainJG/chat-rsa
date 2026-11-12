#!/usr/bin/env bun
// Runs the k6 load test against a running server, then deletes every user the run created.
// Usage: bun run test:load [smoke|load|stress]   (the server must already be running, e.g. `bun run dev`)
import { loadConfig } from '../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../src/backend/shared/database/postgres.config.ts';
import { newRunId, type Profile, PROFILES, runK6, runUserPattern } from '../test/load/k6-runner.ts';

function isProfile(value: string): value is Profile {
  return PROFILES.some((profile) => profile === value);
}

async function run(profile: Profile): Promise<number> {
  const config = loadConfig();
  const baseUrl = Bun.env.LOAD_BASE_URL ?? `http://localhost:${config.port}`;
  const reachable = await fetch(baseUrl).then(
    (response) => response.ok,
    () => false,
  );
  if (!reachable) {
    console.error(`No server at ${baseUrl}. Start it with \`bun run dev\` or set LOAD_BASE_URL.`);
    return 1;
  }

  const runId = newRunId();
  // Built before k6 starts: a malformed runId aborts here instead of widening the delete later.
  const ownUsers = runUserPattern(runId);
  const sql = createPostgresClient({ max: 1, url: config.databaseUrl });
  try {
    // k6 exits 99 when a threshold fails; keep that so CI and scripts can react to it.
    return await runK6({ baseUrl, profile, runId });
  } finally {
    const deleted = await sql<never[]>`DELETE FROM users WHERE name ~ ${ownUsers}`;
    console.info(`Removed ${deleted.count} load-test users (pattern ${ownUsers}).`);
    await sql.close();
  }
}

const profile = Bun.argv[2] ?? 'smoke';
if (isProfile(profile)) {
  process.exitCode = await run(profile);
} else {
  console.error(`Usage: bun run test:load <${PROFILES.join('|')}>`);
  process.exitCode = 1;
}
