import type { Logger } from '../domain/logger.ts';

export type ShutdownOptions = {
  /** Ends the process; `main.ts` passes `(code) => process.exit(code)`. */
  readonly exit: (code: number) => void;
  readonly logger: Logger;
  /** Registers the signal listener; defaults to `process.on`. Tests inject a fake. */
  readonly on?: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly signal: NodeJS.Signals;
  /** Run one after another, in order: for example gateway.drain, server.stop, sql.close. */
  readonly steps: readonly ShutdownStep[];
};

export type ShutdownStep = {
  readonly name: string;
  readonly run: () => Promise<void> | void;
};

/**
 * Traps `signal` and runs the steps once, in order, however many times the signal arrives. A
 * failing step is logged and the later steps still run (the database still closes), then the
 * process exits with 1 instead of 0. Returns the shutdown itself, which tests and callers can also
 * run directly.
 */
export function installShutdown({
  exit,
  logger,
  on = (trapped, listener) => {
    process.on(trapped, listener);
  },
  signal,
  steps,
}: ShutdownOptions): () => Promise<void> {
  let running: null | Promise<void> = null;
  const shutdown = async (): Promise<void> => {
    let failed = false;
    for (const step of steps) {
      try {
        // Sequential on purpose: the server stops only after the gateway drained, and so on.
        // eslint-disable-next-line no-await-in-loop
        await step.run();
      } catch (error) {
        failed = true;
        logger.error(new Error(`Shutdown step ${step.name} failed`, { cause: error }));
      }
    }
    exit(failed ? 1 : 0);
  };
  const trigger = async (): Promise<void> => {
    running ??= shutdown();
    return running;
  };
  on(signal, () => {
    void trigger();
  });
  return trigger;
}
