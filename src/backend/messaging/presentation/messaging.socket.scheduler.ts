/** Stops a scheduled task; calling it twice is harmless. */
export type Cancel = () => void;

/** Timer port, so the gateway's heartbeat and token-expiry timers can be driven by tests. */
export type Scheduler = {
  readonly after: (ms: number, task: () => void) => Cancel;
  readonly repeat: (ms: number, task: () => void) => Cancel;
};

/** `setTimeout` overflows above 2^31 - 1 ms and fires at once; longer delays are clamped. */
const MAX_DELAY_MS = 2_147_483_647;

export const systemScheduler: Scheduler = {
  after: (ms, task) => {
    const handle = setTimeout(task, Math.min(Math.max(0, ms), MAX_DELAY_MS));
    return () => {
      clearTimeout(handle);
    };
  },
  repeat: (ms, task) => {
    const handle = setInterval(task, ms);
    return () => {
      clearInterval(handle);
    };
  },
};
