import { $ } from 'bun';
import { describe, expect, test } from 'bun:test';

import type { K6Run } from './k6-runner.ts';

import {
  containerName,
  type LoadDependencies,
  parseLoadArgs,
  reachable,
  runLoad,
  stopContainer,
  withTimeout,
} from './load.orchestrator.ts';
import { startFakeAuthServer } from './support/fake-auth-server.ts';
import { runK6Against } from './support/k6-probe.test-support.ts';

// BUG-MEDIUM-08 (load run 2): scripts/load.ts had no tests, a pre-flight that only fetched `/`
// (no timeout, no database or cache check), and nothing that stopped k6 on Ctrl+C before cleanup.

type Calls = string[];

function dependencies(calls: Calls, overrides: Partial<LoadDependencies> = {}): LoadDependencies {
  return {
    cleanup: async (runId) => {
      calls.push(`cleanup ${runId}`);
      return { rooms: 1, users: 2 };
    },
    log: { error: (message) => calls.push(`error ${message}`), info: (message) => calls.push(`info ${message}`) },
    newRunId: () => 'testrun0001',
    onSignal: () => () => {
      calls.push('signals off');
    },
    preflight: async () => null,
    resetRateLimits: async (_runId, userIds) => {
      calls.push(`reset ${userIds.join(',')}`);
    },
    runK6: async (run: K6Run) => {
      calls.push(`k6 ${run.script} ${run.name} ${run.runId} ${run.profile}`);
      return 0;
    },
    runUserIds: async () => [7, 8],
    stopContainer: async (name) => {
      calls.push(`stop ${name}`);
    },
    ...overrides,
  };
}

describe('parseLoadArgs', () => {
  test('defaults to the smoke profile and both suites', () => {
    expect(parseLoadArgs([])).toEqual({ profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] });
  });

  test.each([
    [['load', 'auth'], { profile: 'load', scripts: ['auth.load.ts'] }],
    [['stress', 'messages'], { profile: 'stress', scripts: ['messages.load.ts'] }],
    [['smoke', 'all'], { profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] }],
  ] as const)('%p', (argv, expected) => {
    expect(parseLoadArgs(argv)).toEqual(expected);
  });

  test.each([[['spike']], [['smoke', 'chat']], [['smoke', 'auth', 'extra']]])('rejects %p', (argv) => {
    expect(parseLoadArgs(argv)).toBeNull();
  });
});

describe('runLoad', () => {
  test('a failed pre-flight runs no k6 and deletes nothing', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://localhost:1', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, { preflight: async () => 'PostgreSQL is not reachable' }),
    );

    expect(code).toBe(1);
    expect(calls).toEqual(['error PostgreSQL is not reachable']);
  });

  test('runs each suite in order under one runId, resetting buckets around them, then cleans up', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'load', scripts: ['auth.load.ts', 'messages.load.ts'] },
      dependencies(calls),
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      'reset ',
      'k6 auth.load.ts k6-testrun0001-auth testrun0001 load',
      'reset ',
      'k6 messages.load.ts k6-testrun0001-messages testrun0001 load',
      'cleanup testrun0001',
      'reset 7,8',
      'info Removed 2 load-test users and 1 rooms (pattern ^loadtestrun0001[pum][0-9]+$).',
      'signals off',
    ]);
  });

  test('keeps the first failing k6 exit code (99) and still runs every suite and the cleanup', async () => {
    const calls: Calls = [];
    const exits = [99, 0];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] },
      dependencies(calls, { runK6: async () => exits.shift() ?? 0 }),
    );

    expect(code).toBe(99);
    expect(calls.filter((call) => call.startsWith('cleanup'))).toEqual(['cleanup testrun0001']);
  });

  // BUG-LOAD-RUN3-MED-01: only a failure of the first suite was tested.
  test('keeps a failing exit code of the second suite after a passing first one', async () => {
    const calls: Calls = [];
    const exits = [0, 99];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] },
      dependencies(calls, { runK6: async () => exits.shift() ?? 0 }),
    );

    expect(code).toBe(99);
  });

  test('every bucket reset is scoped to the run id, so its sign-in buckets are refilled', async () => {
    const runIds: string[] = [];
    await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] },
      dependencies([], {
        resetRateLimits: async (runId) => {
          runIds.push(runId);
        },
      }),
    );

    expect(runIds).toEqual(['testrun0001', 'testrun0001', 'testrun0001']);
  });

  // BUG-LOAD-RUN3-MED-01: a cleanup that threw skipped the bucket reset entirely.
  test('a cleanup that fails still refills the run users’ buckets', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, {
        cleanup: async () => {
          throw new Error('room 1 has 1 members; minimum is 2');
        },
      }),
    );

    expect(code).toBe(1);
    expect(calls).toContain('reset 7,8');
  });

  test('users that cannot be listed fail a passing run and still refill the shared buckets', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, {
        runUserIds: async () => {
          throw new Error('connection refused');
        },
      }),
    );

    expect(code).toBe(1);
    expect(calls).toContain('error Cleanup failed: connection refused');
    expect(calls.filter((call) => call === 'reset ')).toHaveLength(2);
  });

  test('a k6 that throws still gets its data cleaned up, and the run fails', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, {
        runK6: async () => {
          throw new Error('podman not found');
        },
      }),
    );

    expect(code).toBe(1);
    expect(calls).toContain('error podman not found');
    expect(calls).toContain('cleanup testrun0001');
    expect(calls.at(-1)).toBe('signals off');
  });

  test('a cleanup that fails turns a passing run into a failure and is reported', async () => {
    const calls: Calls = [];
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, {
        cleanup: async () => {
          throw new Error('room 1 has 1 members; minimum is 2');
        },
      }),
    );

    expect(code).toBe(1);
    expect(calls).toContain('error Cleanup failed: room 1 has 1 members; minimum is 2');
    expect(calls.at(-1)).toBe('signals off');
  });

  test('SIGINT stops the running container, skips the next suite, cleans up and exits 130', async () => {
    const calls: Calls = [];
    const signals: { fire?: (signal: 'SIGINT' | 'SIGTERM') => void } = {};
    const k6Done = Promise.withResolvers<number>();
    const code = runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts', 'messages.load.ts'] },
      dependencies(calls, {
        onSignal: (handler) => {
          signals.fire = handler;
          return () => calls.push('signals off');
        },
        runK6: async (run) => {
          calls.push(`k6 ${run.script}`);
          return k6Done.promise;
        },
        stopContainer: async (name) => {
          calls.push(`stop ${name}`);
          k6Done.resolve(137);
        },
      }),
    );
    await Bun.sleep(10);
    signals.fire?.('SIGINT');

    expect(await code).toBe(130);
    expect(calls).toContain('stop k6-testrun0001-auth');
    expect(calls).not.toContain('k6 messages.load.ts');
    expect(calls).toContain('cleanup testrun0001');
    // BUG-LOAD-RUN3-MED-01: no bucket reset for a suite that will not run.
    expect(calls.slice(0, calls.indexOf('cleanup testrun0001'))).toEqual([
      'reset ',
      'k6 auth.load.ts',
      'stop k6-testrun0001-auth',
    ]);
  });

  test('SIGTERM while the buckets are being reset starts no k6, cleans up and exits 143', async () => {
    const calls: Calls = [];
    const signals: { fire?: (signal: 'SIGINT' | 'SIGTERM') => void } = {};
    const code = await runLoad(
      { baseUrl: 'http://x', profile: 'smoke', scripts: ['auth.load.ts'] },
      dependencies(calls, {
        onSignal: (handler) => {
          signals.fire = handler;
          return () => calls.push('signals off');
        },
        resetRateLimits: async (_runId, userIds) => {
          calls.push(`reset ${userIds.join(',')}`);
          signals.fire?.('SIGTERM');
        },
      }),
    );

    expect(code).toBe(143);
    expect(calls.some((call) => call.startsWith('k6 '))).toBe(false);
    expect(calls).toContain('cleanup testrun0001');
  });
});

describe('pre-flight reachability', () => {
  test('gives up on a server that accepts connections but never answers', async () => {
    const hanging = Bun.serve({ fetch: async () => Promise.withResolvers<Response>().promise, port: 0 });
    try {
      const started = Date.now();
      expect(await reachable(`http://localhost:${hanging.port}`, 200)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await hanging.stop(true);
    }
  });

  test('accepts a server that answers 200 and refuses one that answers 500', async () => {
    const up = Bun.serve({ fetch: () => new Response('ok'), port: 0 });
    const broken = Bun.serve({ fetch: () => new Response('no', { status: 500 }), port: 0 });
    try {
      expect(await reachable(`http://localhost:${up.port}`, 1000)).toBe(true);
      expect(await reachable(`http://localhost:${broken.port}`, 1000)).toBe(false);
    } finally {
      await up.stop(true);
      await broken.stop(true);
    }
  });
});

// BUG-LOAD-RUN3-MED-01: the pre-flight timeout was a `Bun.sleep` nobody cancelled, so every check
// kept the process alive for the full timeout after it had answered.
describe('withTimeout', () => {
  test('true for a promise that settles in time, false for one that rejects or hangs', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 1000)).toBe(true);
    expect(await withTimeout(Promise.reject(new Error('down')), 1000)).toBe(false);
    expect(await withTimeout(Promise.withResolvers<never>().promise, 20)).toBe(false);
  });

  test('cancels its timer once the promise settles, so the process can exit at once', async () => {
    const module = new URL('load.orchestrator.ts', import.meta.url).pathname;
    const started = performance.now();
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { withTimeout } = await import(${JSON.stringify(module)}); await withTimeout(Promise.resolve(), 10_000);`,
      ],
      { stderr: 'pipe' },
    );
    expect(await child.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
  }, 15_000);
});

describe('named k6 containers', () => {
  test('containerName is unique per run and suite, and valid for podman', () => {
    expect(containerName('testrun0001', 'auth.load.ts')).toBe('k6-testrun0001-auth');
    expect(containerName('testrun0001', 'messages.load.ts')).toBe('k6-testrun0001-messages');
  });

  test('stopContainer stops a running k6 by name, and --rm leaves no container behind', async () => {
    const fake = startFakeAuthServer('honest');
    const runId = 'stoptest0001';
    const name = containerName(runId, 'auth.load.ts');
    try {
      const running = runK6Against(fake, { name, profile: 'stress', runId });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const listed = await $`podman ps --filter name=^${name}$ --format {{.Names}}`.nothrow().text();
        if (listed.trim() === name) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await Bun.sleep(100);
      }
      const started = Date.now();
      await stopContainer(name);
      const { exitCode } = await running;

      expect(exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      const left = await $`podman ps -a --filter name=^${name}$ --format {{.Names}}`.nothrow().text();
      expect(left.trim()).toBe('');
    } finally {
      await fake.stop();
    }
  }, 60_000);
});
