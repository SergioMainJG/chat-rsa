#!/usr/bin/env bun
// Runs the k6 load suites against a running server, then deletes everything the run created.
// Usage: bun run test:load [smoke|load|stress] [auth|messages|all]   (the server must be running)
import { RedisClient } from 'bun';

import { loadConnectionConfig } from '../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../src/backend/shared/database/postgres.config.ts';
import { newRunId, runK6 } from '../test/load/k6-runner.ts';
import { deleteRunData, resetRateLimits, runUserIds } from '../test/load/load.cleanup.ts';
import {
  parseLoadArgs,
  reachable,
  runLoad,
  type Signal,
  stopContainer,
  usage,
  withTimeout,
} from '../test/load/load.orchestrator.ts';

async function main(): Promise<number> {
  const args = parseLoadArgs(Bun.argv.slice(2));
  if (args === null) {
    console.error(usage());
    return 1;
  }
  // The load script signs no tokens, so it does not need (or check) JWT_SECRET.
  const config = loadConnectionConfig();
  const baseUrl = Bun.env.LOAD_BASE_URL ?? `http://localhost:${config.port}`;
  const sql = createPostgresClient({ max: 1, url: config.databaseUrl });
  const cache = new RedisClient(config.cacheUrl);
  try {
    return await runLoad(
      { baseUrl, ...args },
      {
        cleanup: async (runId) => deleteRunData(sql, runId),
        log: { error: console.error, info: console.info },
        newRunId,
        onSignal: (handler) => {
          const listener = (signal: Signal): void => {
            handler(signal);
          };
          process.on('SIGINT', listener);
          process.on('SIGTERM', listener);
          return () => {
            process.off('SIGINT', listener);
            process.off('SIGTERM', listener);
          };
        },
        // `GET /` never touches PostgreSQL or Valkey, so both are checked on their own.
        preflight: async () => {
          if (!(await reachable(baseUrl))) {
            return `No server at ${baseUrl}. Start it with \`bun run dev\` or set LOAD_BASE_URL.`;
          }
          if (!(await withTimeout(sql`SELECT 1`))) {
            return 'PostgreSQL is not reachable; the cleanup could not run. Start it with `bun run pod:infra`.';
          }
          if (!(await withTimeout(cache.send('PING', [])))) {
            return 'Valkey is not reachable; rate-limit buckets could not be reset. Start it with `bun run pod:infra`.';
          }
          return null;
        },
        resetRateLimits: async (runId, userIds) => resetRateLimits(cache, userIds, runId),
        runK6,
        runUserIds: async (runId) => runUserIds(sql, runId),
        stopContainer,
      },
    );
  } finally {
    try {
      cache.close();
    } finally {
      await sql.close();
    }
  }
}

process.exitCode = await main();
