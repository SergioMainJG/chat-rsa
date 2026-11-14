import { describe, expect, test } from 'bun:test';

import type { Profile } from './k6-runner.ts';

import { type MessagesSabotage, startFakeMessagesServer } from './support/fake-messages-server.ts';
import {
  crossed,
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// Each case runs the real k6 messaging script against the real server and gateway, wired to
// in-memory adapters, with one deliberate defect (BUG-CRITICAL-01 in bugs/load.bug.md). The `honest`
// case proves the wiring is faithful: the same script passes against it.

type Outcome = ProbeRun & { readonly storedMessages: number };

async function runAgainst(sabotage: MessagesSabotage, profile: Profile = 'smoke'): Promise<Outcome> {
  const server = startFakeMessagesServer(sabotage);
  try {
    const run = await runK6Against(server, { profile, script: 'messages.load.ts' });
    return { ...run, storedMessages: server.storedMessages() };
  } finally {
    await server.stop();
  }
}

/** Smoke runs 3 live iterations of 5 messages each; a stale-epoch send is never stored. */
const SMOKE_MESSAGES = 3 * 5;
const UNEXPECTED_STATUS: ReadonlySet<MessagesSabotage> = new Set(['non-member-history', 'sender-keys-500']);

describe('k6 messages suite against sabotaged servers', () => {
  test(
    'passes against the honest server, and stores each idempotent message once',
    async () => {
      const outcome = await runAgainst('honest');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      expect(outcome.summary?.root_group.checks['send is acked with the stored message']).toMatchObject({
        fails: 0,
        passes: SMOKE_MESSAGES,
      });
      expect(outcome.storedMessages).toBe(SMOKE_MESSAGES);
    },
    K6_TIMEOUT_MS,
  );

  test(
    'stress bursts past the user bucket and every 429 carries Retry-After and the error shape',
    async () => {
      const outcome = await runAgainst('honest', 'stress');

      expect(outcome.exitCode).toBe(0);
      expect(failedChecks(outcome)).toEqual([]);
      expect(outcome.summary?.metrics.rate_limited?.count ?? 0).toBeGreaterThan(0);
      expect(
        outcome.summary?.root_group.checks['429 carries an integer Retry-After of at least 1']?.passes ?? 0,
      ).toBeGreaterThan(0);
    },
    K6_TIMEOUT_MS,
  );

  test.each([
    [
      'duplicate-fan-out',
      'an idempotent retry is stored and fanned out again',
      ['retry is acked as a duplicate of the original', 'retry is not fanned out again', 'history pages are complete'],
    ],
    ['history-ascending', 'history pages come oldest first', ['history is newest first']],
    ['history-overlap', 'nextBefore is an inclusive cursor, so pages overlap', ['history pages are disjoint']],
    ['no-ack', 'the gateway never acks a send', ['send is acked with the stored message']],
    ['non-member-history', 'a non-member reads the history', ['non-member history is 403']],
    [
      'sender-keys-500',
      'the sender-keys upload answers 500',
      ['sender-keys upload is 201', 'sender keys reach the recipient'],
    ],
  ] as const)(
    'catches %s (%s)',
    async (sabotage, _description, checks) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'checks')).toBe(true);
      for (const name of checks) {
        expect(failedChecks(outcome)).toContain(name);
      }
      // A 500 upload and a 200 history for a non-member are unexpected statuses; the other
      // sabotages keep every status and break only the bodies or frames.
      expect(crossed(outcome, 'http_req_failed')).toBe(UNEXPECTED_STATUS.has(sabotage));
    },
    K6_TIMEOUT_MS,
  );

  test(
    'catches no-rate-limit: a stress burst that never gets 429',
    async () => {
      const outcome = await runAgainst('no-rate-limit', 'stress');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'rate_limited')).toBe(true);
      expect(failedChecks(outcome)).toContain('a burst past the user bucket gets 429');
    },
    K6_TIMEOUT_MS,
  );

  test(
    'catches no-retry-after: a 429 without Retry-After',
    async () => {
      const outcome = await runAgainst('no-retry-after', 'stress');

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toEqual(['429 carries an integer Retry-After of at least 1']);
    },
    K6_TIMEOUT_MS,
  );
});
