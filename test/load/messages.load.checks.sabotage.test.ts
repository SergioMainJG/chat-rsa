import { describe, expect, test } from 'bun:test';

import { type MessagesSabotage, probeMessages } from './support/fake-messages-server.ts';
import { crossed, failedChecks, K6_TIMEOUT_MS, THRESHOLD_FAILED } from './support/k6-probe.test-support.ts';

// Each case runs the real k6 messaging script (smoke) against the real server and gateway with one
// deliberate defect, and asserts the exact set of checks that catch it, so a check that also fails
// for an unrelated defect, or a defect that cascades into unrelated checks, shows up here.

type Case = readonly [
  sabotage: MessagesSabotage,
  defect: string,
  failing: readonly string[],
  /** True when the defect is an unexpected status, which `http_req_failed` must also catch. */
  unexpectedStatus: boolean,
];

const LIVE: readonly Case[] = [
  [
    'duplicate-fan-out',
    'an idempotent retry is stored and fanned out again',
    ['history pages are complete', 'retry is acked as a duplicate of the original', 'retry is not fanned out again'],
    false,
  ],
  [
    'no-ack',
    'the gateway never acks a send',
    ['retry is acked as a duplicate of the original', 'send is acked with the stored message'],
    false,
  ],
  [
    'no-fan-out',
    'message.new never reaches the other member',
    ['message.new reaches the other member', 'retry is not fanned out again'],
    false,
  ],
  ['no-upgrade', 'every /ws upgrade is refused', ['ws upgrade opens both sockets'], false],
  ['ready-without-rooms', 'ready lists no rooms', ['ready lists the room'], false],
  ['no-receipt-push', 'receipt frames are never pushed', ['read receipt reaches the sender'], false],
  ['no-rotation-push', 'room.rotated is never pushed', ['a join rotates the epoch for live sockets'], false],
  [
    'stale-epoch-wrong-code',
    'a stale-epoch send is refused as internal, not conflict',
    ['a stale-epoch send is refused with conflict'],
    false,
  ],
  [
    'no-refresh-push',
    'an HTTP refresh does not push auth.refreshed',
    ['an HTTP refresh pushes auth.refreshed to the session socket'],
    false,
  ],
  [
    'refresh-frame-ignored',
    'the gateway ignores auth.refresh frames',
    ['an auth.refresh frame with a fresh token is accepted'],
    false,
  ],
  [
    'sign-out-keeps-sockets',
    'sign-out leaves the session sockets open',
    ['sign-out closes the session socket with 4001'],
    false,
  ],
];

const HISTORY: readonly Case[] = [
  ['history-ascending', 'each page comes oldest first', ['history is newest first'], false],
  ['history-overlap', 'nextBefore is an inclusive cursor, so pages overlap', ['history pages are disjoint'], false],
  ['history-oversized', 'pages hold twice the limit', ['history pages hold at most the limit'], false],
  ['non-member-history', 'a non-member reads the history', ['non-member history is 403'], true],
  ['non-member-history-500', 'refusing a non-member crashes with 500', ['non-member history is 403'], true],
];

const REST: readonly Case[] = [
  [
    'room-created-alone',
    'a new room is reported without the other member',
    ['room is created with both members'],
    false,
  ],
  ['rooms-list-empty', 'the rooms list is empty', ['rooms list includes the new room'], false],
  ['lookup-wrong-user', 'the lookup answers another id', ['user lookup returns {id, name}'], false],
  ['keys-missing-member', 'a member key is missing', ['room keys list every member'], false],
  ['join-wrong-members', 'the join answer misses the new member', ['adding a member rotates the epoch'], false],
  ['leave-stale-epoch', 'the leave answer keeps the old epoch', ['leaving rotates the epoch'], false],
  [
    'sender-keys-500',
    'the sender-keys upload answers 500',
    ['sender keys reach the recipient', 'sender-keys upload is 201'],
    true,
  ],
  ['sender-keys-not-stored', 'the upload stores nothing', ['sender-keys upload is 201'], false],
  ['sender-keys-lost', 'the recipient finds no envelope', ['sender keys reach the recipient'], false],
  ['receipts-unordered', 'receipts are not ordered by user id', ['receipts list every member'], false],
  ['receipts-stale', 'receipts never advance', ['receipts advance to the read message'], false],
  ['members-without-names', 'members are listed without names', ['room members are listed with their names'], false],
  ['members-open', 'a non-member lists the members', ['non-member members list is 403'], true],
];

const SESSION_COOKIE: readonly Case[] = [
  [
    'refresh-token-in-body',
    'refresh also returns the token in the body',
    ['refresh returns {user} and a fresh session cookie'],
    false,
  ],
  [
    'refresh-new-session',
    'refresh starts a new session instead of keeping it',
    // The socket of the old session then rightly refuses the new token.
    ['an auth.refresh frame with a fresh token is accepted', 'refreshed token keeps its session'],
    false,
  ],
  [
    'refresh-cookie-readable',
    'the refreshed session cookie is not HttpOnly',
    ['refresh sets an HttpOnly, Secure session cookie for one token lifetime'],
    false,
  ],
  [
    'refresh-cookie-lax',
    'the refreshed session cookie is SameSite=Lax',
    ['refresh sets a SameSite=Strict session cookie on Path=/'],
    false,
  ],
  ['refresh-hint-stale', 'the hint cookie lags the new exp', ['refresh sets the hint cookie to the new exp'], false],
  [
    'cookie-auth-ignored',
    'the guard ignores the session cookie',
    ['the session cookie alone authenticates a request'],
    true,
  ],
];

describe.each([
  ['live sockets', LIVE],
  ['history', HISTORY],
  ['REST bodies', REST],
  ['refresh and the session cookie', SESSION_COOKIE],
] as const)('k6 messages suite catches %s defects', (_area, cases) => {
  test.each(cases)(
    'catches %s (%s)',
    async (sabotage, _defect, failing, unexpectedStatus) => {
      const outcome = await probeMessages(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(crossed(outcome, 'checks')).toBe(true);
      expect(failedChecks(outcome).toSorted()).toEqual(failing.toSorted());
      expect(crossed(outcome, 'http_req_failed')).toBe(unexpectedStatus);
    },
    K6_TIMEOUT_MS,
  );
});

describe('k6 messages suite survives a malformed error body', () => {
  test(
    'catches bad-timestamp, and the rest of the iteration still runs',
    async () => {
      const outcome = await probeMessages('bad-timestamp');
      const checks = outcome.summary?.root_group.checks ?? {};

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      expect(failedChecks(outcome)).toEqual(['non-member history is 403']);
      // A thrown RangeError would have skipped every check after the history request.
      for (const name of [
        'receipts list every member',
        'refresh returns {user} and a fresh session cookie',
        'the session cookie alone authenticates a request',
      ]) {
        expect(checks[name]).toMatchObject({ fails: 0, passes: 3 });
      }
    },
    K6_TIMEOUT_MS,
  );
});
