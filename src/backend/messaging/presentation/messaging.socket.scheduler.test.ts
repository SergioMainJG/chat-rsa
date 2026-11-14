import { afterEach, describe, expect, test } from 'bun:test';

import { type Cancel, systemScheduler } from './messaging.socket.scheduler.ts';

// BUG-MEDIUM-12 (backend): the real timers behind the gateway's heartbeat and token expiry.

const cancels: Cancel[] = [];

afterEach(() => {
  for (const cancel of cancels.splice(0)) {
    cancel();
  }
});

function counter(): { calls: number; readonly task: () => void } {
  const state = {
    calls: 0,
    task: () => {
      state.calls += 1;
    },
  };
  return state;
}

describe('systemScheduler.after', () => {
  test('runs the task once after the delay', async () => {
    const tick = counter();
    cancels.push(systemScheduler.after(5, tick.task));
    expect(tick.calls).toBe(0);
    await Bun.sleep(40);
    expect(tick.calls).toBe(1);
  });

  test('a delay past 2^31 - 1 ms is clamped instead of overflowing into an immediate run', async () => {
    const tick = counter();
    cancels.push(systemScheduler.after(2_147_483_647 + 60_000, tick.task));
    await Bun.sleep(40);
    expect(tick.calls).toBe(0);
  });

  test('a negative delay (an already expired token) runs at once', async () => {
    const tick = counter();
    cancels.push(systemScheduler.after(-5000, tick.task));
    await Bun.sleep(20);
    expect(tick.calls).toBe(1);
  });

  test('cancel stops a pending task, and cancelling twice is harmless', async () => {
    const tick = counter();
    const cancel = systemScheduler.after(5, tick.task);
    cancel();
    cancel();
    await Bun.sleep(40);
    expect(tick.calls).toBe(0);
  });
});

describe('systemScheduler.repeat', () => {
  test('runs the task on every interval until cancelled', async () => {
    const tick = counter();
    const cancel = systemScheduler.repeat(5, tick.task);
    await Bun.sleep(60);
    cancel();
    const seen = tick.calls;
    expect(seen).toBeGreaterThanOrEqual(3);
    await Bun.sleep(40);
    expect(tick.calls).toBe(seen);
    cancel();
  });
});
