import { describe, expect, test } from 'bun:test';

import { installShutdown, type ShutdownStep } from './lifecycle.shutdown.ts';

type Trap = { readonly fire: () => void; readonly signals: string[] };

function recorder(log: string[], name: string, fail = false): ShutdownStep {
  return {
    name,
    run: async () => {
      await Bun.sleep(1);
      log.push(name);
      if (fail) {
        throw new Error(`${name} failed`);
      }
    },
  };
}

function trap(): Trap & { readonly on: (signal: string, listener: () => void) => void } {
  const listeners: Array<() => void> = [];
  const signals: string[] = [];
  return {
    fire: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    on: (signal, listener) => {
      signals.push(signal);
      listeners.push(listener);
    },
    signals,
  };
}

describe('installShutdown', () => {
  test('traps the signal once and runs every step in order, then exits with 0', async () => {
    const log: string[] = [];
    const exits: number[] = [];
    const signal = trap();
    const shutdown = installShutdown({
      exit: (code) => exits.push(code),
      logger: { error: () => null },
      on: signal.on,
      signal: 'SIGTERM',
      steps: [recorder(log, 'gateway.drain'), recorder(log, 'server.stop'), recorder(log, 'sql.close')],
    });
    expect(signal.signals).toEqual(['SIGTERM']);

    signal.fire();
    signal.fire();
    await shutdown();
    expect(log).toEqual(['gateway.drain', 'server.stop', 'sql.close']);
    expect(exits).toEqual([0]);
  });

  test('a failing step is logged, the later steps still run, and the exit code is 1', async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const exits: number[] = [];
    const signal = trap();
    const shutdown = installShutdown({
      exit: (code) => exits.push(code),
      logger: { error: (error) => errors.push(error) },
      on: signal.on,
      signal: 'SIGTERM',
      steps: [recorder(log, 'gateway.drain', true), recorder(log, 'sql.close')],
    });
    signal.fire();
    await shutdown();
    expect(log).toEqual(['gateway.drain', 'sql.close']);
    expect(errors).toHaveLength(1);
    expect(exits).toEqual([1]);
  });
});
