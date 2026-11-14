# Adversarial QA Vulnerability & Mutation Audit (Run 3 — `messages` Load Suite & Harness): Load Test Suite (`test/load` & `scripts/load.ts`)

## Executive Summary

A third-round adversarial QA evaluation (black-box, gray-box, white-box, boundary value analysis, branch coverage, race-condition probing, and `@stryker-mutator/core` mutation testing) was executed against the expanded `messages` load-testing suite and orchestration harness (`test/load/messages.load.ts`, `test/load/messages.load.sabotage.test.ts`, `test/load/support/fake-messages-server.ts`, `test/load/load.cleanup.ts`, `test/load/load.orchestrator.ts`, `test/load/k6-runner.ts`, `scripts/load.ts`, and their companion test files) following the Run 2 remediation.

Although `bun run test:load:probes` (`98 pass, 0 fail`), the load integration tests (`10 pass, 0 fail`), and `bun run verify` (`572 pass, 0 fail`) pass 100%, adversarial testing and Stryker mutation analysis (**98 surviving mutants across `test/load/support/fake-messages-server.ts`, `test/load/load.orchestrator.ts`, `test/load/load.cleanup.ts`, `test/load/k6-runner.ts`, and `scripts/load.ts`**) uncovered **8 confirmed defects (3 Critical, 4 High, 1 Medium)**:

1. **66.7% (18 of 27) of `check()` assertions in `messages.load.ts` have 0% sabotage coverage**, and **7 real-time `/ws` protocol frame types & REST query filters (`presence`, `presence.snapshot`, `typing`, `room.subscribe`, `auth.refresh`, `sender-keys.available`, `delivered` receipts, `?keyEpoch=`, `?since=`, `?until=`) have 0% load coverage**.
2. **`fake-messages-server.ts` fakes out the IP rate-limit policy at `capacity: 100_000, refillPerSecond: 100_000` (833x the real server's `120`)**, hiding the fact that `messages.load.ts` (`stress`) **fails 100% of the time (`exitCode = 99`, `http_req_failed = 16.75%`, 9 failed checks)** against the real server's default IP policy (`capacity: 120, refillPerSecond: 20`).
3. **Regression of Run 2 `BUG-CRITICAL-04` and `BUG-HIGH-07` inside `messages.load.ts`**:
   - `hasErrorShape` in `messages.load.ts:157` calls `new Date(timestamp).toISOString() === timestamp` without guarding against invalid dates, throwing an uncaught `RangeError: Invalid time value` inside k6 (`script exception`) that aborts `rest()` iterations and skips `receipts` and `refresh` checks, and has **0% per-field error-shape sabotage coverage**.
   - `POST /api/auth/refresh` (`messages.load.ts:387-397`) and `signUp` (`messages.load.ts:215-220`) do not decode JWT claims (`alg`, `sub`, `name`, `exp`), accepting `"undefined.undefined.undefined"` (`3/3 passes`).
4. **15 surviving Stryker mutants in `MisorderedMessageRepository` (`fake-messages-server.ts:106-138`) & 5 cascading false-failing checks in `no-ack`**:
   - `history-ascending` and `history-overlap` produce the **exact same 3 failed checks** (`['history is newest first', 'history pages are complete', 'history pages are disjoint']`), so deleting `if (this.mode === 'ascending')` or swapping both modes passes 100% of `messages.load.sabotage.test.ts`.
   - `'history pages hold at most the limit'` (`messages.load.ts:587`) is dead/untestable through `MessageRepository.page` because `HistoryUseCase.execute` slices `rows.slice(0, limit)` itself, and `'history pages are disjoint'` false-passes on `pages === null`.
   - In `no-ack`, `messages.load.ts:568` compares `messageOf(delivered)?.id === stored?.id` (`"019..." === undefined`), causing **5 unrelated checks** (`message.new`, `read receipt`, `receipts advance`, `history pages are complete`) to false-fail alongside `send is acked` while taking **44.9 seconds** to time out.
5. **22 additional surviving mutants in `fake-messages-server.ts` (`non-member-history`, `sender-keys-500`, `withoutRetryAfter`, `stop`)**: replacing `history.execute` with `async () => {}` crashes every history request with `500 Internal Server Error` (`TypeError: undefined is not an object`) yet passes the `non-member-history` test because `messages.load.sabotage.test.ts:90` uses `.toContain(name)` instead of `.toEqual(checks)`.
6. **Multi-suite exit-code masking and signal/cleanup bugs in `load.orchestrator.ts`**:
   - Mutating `codes.find((code) => code !== 0)` to `codes.find(() => true)` (`load.orchestrator.ts:126`) **survived**, masking any `messages.load.ts` failure (`99`) whenever `auth.load.ts` passes (`0`).
   - Mutating `k6Code === 0 && !cleaned ? 1 : k6Code` to `true && !cleaned ? 1 : k6Code` (`load.orchestrator.ts:133`) **survived**, overwriting k6's exit code `99` with `1` when cleanup also fails.
   - When `deps.cleanup(runId)` throws in `cleanUp()` (`load.orchestrator.ts:143`), `await deps.resetRateLimits(userIds)` on line 144 is **skipped**, leaving Valkey rate-limit buckets exhausted.
   - When `SIGINT` interrupts `auth.load.ts`, the loop still calls `await deps.resetRateLimits([])` for the skipped `messages.load.ts` suite before checking `if (signals.interrupted !== null)`.
7. **`runUserIds` in `load.cleanup.ts:48` has 0% test coverage (BlockStatement `{}` survived)**, and `deleteRunData` rolls back 100% of the run's cleanup (`0` users and `0` rooms deleted) if a load user joined a foreign room that later dropped to 2 members.
8. **`newRunId()` entropy length mutant (`byte * 36` instead of `byte % 36`) survived in `k6-runner.ts:32`**, and `scripts/load.ts` (37 surviving mutants, 33.93% score) leaks un-cancelled 5,000 ms `Bun.sleep` timers in `withTimeout()`.

---

## 1. Confirmed Bugs, Race Conditions & Surviving Mutants

### BUG-CRITICAL-01: 18 of 27 `check()` Assertions (66.7%) in `messages.load.ts` Have Zero Sabotage Coverage, and 7 Core `messages` `/ws` & REST Flows Are Never Exercised

- **Classification**: Black-Box & White-Box / Unverified Assertions & Missing Protocol Load Coverage.
- **Target**:
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L1-L766)
  - [messages.load.sabotage.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.sabotage.test.ts#L67-L120)
  - [fake-messages-server.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/support/fake-messages-server.ts#L55-L65)
- **How It Was Attacked**:
  Audited all 27 `check(...)` predicates in `test/load/messages.load.ts` against the 8 sabotages in `test/load/support/fake-messages-server.ts` and `test/load/messages.load.sabotage.test.ts`, and cross-referenced the protocol surface in `src/backend/messaging/presentation/messaging.socket.gateway.ts` and `src/backend/messaging/presentation/messaging.controller.ts`.
- **What Failed & How It Failed**:
  1. Line 4 of `test/load/messages.load.ts` claims:
     `// test/load/messages.load.sabotage.test.ts proves that each check below catches a real defect.`
     In reality, **18 out of 27 `check()` predicates (66.7%) in `messages.load.ts` have 0% sabotage coverage**. Deleting all 18 checks simultaneously (or replacing their predicates with `() => true`) leaves `bun test ./test/load/messages.load.sabotage.test.ts` passing `10/10`:
     - `'room is created with both members'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L257))
     - `'rooms list includes the new room'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L324))
     - `'user lookup returns {id, name}'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L328))
     - `'room keys list every member'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L334))
     - `'adding a member rotates the epoch'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L353))
     - `'leaving rotates the epoch'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L357))
     - `'receipts list every member'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L379))
     - `'refresh returns {user, token}'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L387))
     - `'ws upgrade opens both sockets'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L628))
     - `'ready lists the room'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L634))
     - `'message.new reaches the other member'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L567))
     - `'read receipt reaches the sender'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L667))
     - `'receipts advance to the read message'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L679))
     - `'a join rotates the epoch for live sockets'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L719))
     - `'a stale-epoch send is refused with conflict'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L727))
     - `'history pages hold at most the limit'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L587))
     - `'a burst is answered only with 200 or 429'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L754))
     - `'429 has the shared error shape'` ([messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L762))
  2. **7 `messages` protocol flows have 0% load & sabotage coverage in `messages.load.ts`**:
     - WebSocket client frames never sent: `room.subscribe`, `typing` (`active: true | false`), `auth.refresh`, and `receipt` (`kind: 'delivered'`).
     - WebSocket server broadcasts never asserted: `presence` (`online: true | false`), `presence.snapshot`, `typing`, `auth.refreshed`, `sender-keys.available` (emitted on `POST /api/rooms/:roomId/sender-keys`), and per-socket frame rate limiting (`rate_limited` / close `1008`).
     - REST query filters never exercised: `GET /api/rooms/:roomId/sender-keys?keyEpoch=<n>` and `GET /api/rooms/:roomId/messages?since=<iso>&until=<iso>`.
- **Expected Behavior**:
  Add dedicated one-defect sabotages in `fake-messages-server.ts` and `messages.load.sabotage.test.ts` so every `check()` in `messages.load.ts` is independently proven to fail when its underlying contract is broken, and exercise `sender-keys.available`, `presence`/`presence.snapshot`, `typing`, `auth.refresh`, `room.subscribe`, and `?keyEpoch=` / `?since=` / `?until=` query filters in `messages.load.ts`.

---

### BUG-CRITICAL-02: `fake-messages-server.ts` Fakes `IP_POLICY` at `100,000 req/s` (833x the Real Server's `120`), Masking a 100% `stress` Profile Failure (`exitCode = 99`, `http_req_failed = 16.75%`) Against the Real Server

- **Classification**: Gray-Box / Dishonest Test Double & Rate-Limit Budget Collision.
- **Target**:
  - [fake-messages-server.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/support/fake-messages-server.ts#L76-L83)
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L85-L112)
  - [messages.load.sabotage.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.sabotage.test.ts#L52-L65)
- **How It Was Attacked**:
  Executed a live k6 probe (`PROBE 1`) running `messages.load.ts` with `PROFILE=stress` against `createServer` wired with the real default `loadConfig({}).rateLimit` policies (`ip: { capacity: 120, refillPerSecond: 20 }, user: { capacity: 60, refillPerSecond: 10 }`).
- **What Failed & How It Failed**:
  1. `test/load/support/fake-messages-server.ts:2-3` states:
     `// The honest mode IS the real contract (same controllers, use cases, guards and gateway as main.ts)`
     Yet on line 82, `fake-messages-server.ts` replaces the server's default IP bucket (`capacity: 120, refillPerSecond: 20`) with:
     ```ts
     const IP_POLICY = { capacity: 100_000, refillPerSecond: 100_000 };
     ```
  2. Why? Because under `PROFILE=stress`, `messages.load.ts` runs `setup()` (`18` requests), `rate_limit` (`BURST = 90` requests in a single `batch()`), `rest` (`12` iterations = `132` requests), and `live` (`12` iterations = `84` HTTP requests + `24` `/ws` upgrades) concurrently from the same loopback IP!
  3. Every authenticated request in `createGuards` (`src/backend/shared/http/http.guard.ts:43-50`) consumes **one token from the IP bucket BEFORE checking the user bucket**.
  4. When run against the real `IP_POLICY` (`capacity: 120, refillPerSecond: 20`), the `BURST = 90` batch plus `setup()` (`18` requests) immediately drains `108` of the `120` IP tokens, causing concurrent `rest` and `live` requests (`POST /api/rooms`, `POST /api/rooms/:id/sender-keys`, `GET /api/rooms/:id/messages`, `POST /api/auth/refresh`) to fail with `429 Too Many Requests`:
     ```text
     PROBE 1 (real IP_POLICY on stress): {
       crossedChecks: true,
       crossedHttpReqFailed: true,
       exitCode: 99,
       failedChecks: [
         "room is created with both members",
         "sender-keys upload is 201",
         "sender keys reach the recipient",
         "non-member history is 403",
         "receipts list every member",
         "refresh returns {user, token}",
         "history is newest first",
         "history pages are complete",
         "history pages hold at most the limit"
       ],
     }
     ```
     Unlike `auth.load.rate-limit.sabotage.test.ts:62` (which explicitly models the real `IP_POLICY` in `fake-auth-server.ts` and asserts the documented saturation behavior), `fake-messages-server.ts` hides the IP bucket exhaustion behind a fake `100,000` IP policy, so `bun run test:load stress messages` passes in probes (`exitCode = 0`) and fails in production/dev (`exitCode = 99`).
- **Expected Behavior**:
  Either model the real `loadConfig({}).rateLimit.ip` policy in `fake-messages-server.ts` (matching `fake-auth-server.ts`) and assert the expected `stress` behavior honestly, or scope `messages.load.ts` scenarios/thresholds so `fake-messages-server.ts` (`honest`) and the real server behave identically under `bun run test:load stress messages`.

---

### BUG-CRITICAL-03: `hasErrorShape` in `messages.load.ts` Crashes with Uncaught `RangeError: Invalid time value` on Malformed Timestamps (Skipping Subsequent Checks), and `POST /api/auth/refresh` Accepts `"undefined.undefined.undefined"` JWTs

- **Classification**: White-Box / Regression of Run 2 `BUG-CRITICAL-04` & `BUG-HIGH-07` in `messages.load.ts`.
- **Target**:
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L136-L159)
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L205-L234)
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L385-L399)
- **How It Was Attacked**:
  1. Executed `PROBE 2A`: ran `messages.load.ts` (`smoke`) against a server whose `403 Forbidden` response on `GET /api/rooms/:roomId/messages` returned `timestamp: "yesterday"`.
  2. Executed `PROBE 2B`: ran `messages.load.ts` (`smoke`) against a server whose `POST /api/auth/refresh` returned `token: "undefined.undefined.undefined"`.
- **What Failed & How It Failed**:
  1. **Uncaught `RangeError: Invalid time value` in `hasErrorShape` (`messages.load.ts:156-157`)**:
     In Run 2 (`odd/tasks/load-messages-bugs.md` Log `L4`), `auth.load.ts` was fixed to use `isIsoTimestamp(timestamp)` after discovering that `new Date('yesterday').toISOString()` throws an uncaught `RangeError` inside k6.
     However, `messages.load.ts:156-157` still uses the unguarded expression:
     ```ts
     typeof timestamp === "string" && new Date(timestamp).toISOString() === timestamp;
     ```
     When a `403` or `429` error response has a non-date `timestamp` (e.g. `"yesterday"` or `""`), `hasErrorShape` throws `RangeError: Invalid time value` inside k6 (`script exception`), **aborting the `rest()` iteration at line 369 before `GET /api/rooms/:roomId/receipts` and `POST /api/auth/refresh` are ever called**:
     ```text
     level=error msg="RangeError: Invalid time value
       at toISOString (native)
       at hasErrorShape (file:///scripts/messages.load.ts:157:36(81))
       at non-member history is 403 (file:///scripts/messages.load.ts:371:20(12))"
     PROBE 2A (bad timestamp on 403 in messages.load.ts): {
       exitCode: 99,
       nonMemberHistoryCheck: { fails: 3, passes: 0 },
       receiptsListCheck: undefined,
       refreshCheck: undefined,
     }
     ```
     Furthermore, **none of the individual fields of `hasErrorShape` in `messages.load.ts` (`statusCode`, `error`, `path`, `correlationId`, `message`, `timestamp`) has any sabotage test** in `messages.load.sabotage.test.ts`.
  2. **`POST /api/auth/refresh` and `setup()` `signUp` Accept `"undefined.undefined.undefined"` (`messages.load.ts:215-220` & `387-397`)**:
     While `auth.load.ts` was hardened in Run 2 (`BUG-CRITICAL-04`) with `hasUsableClaims(token, id, name)` to base64url-decode the JWT header and payload and verify `header.alg === 'HS256'`, `payload.sub === String(id)`, `payload.name === name`, and `payload.exp * 1000 > Date.now()`, `messages.load.ts:387-397` still uses the Run 1 regex check:
     ```ts
     body.token.split(".").length === 3 &&
       body.token.split(".").every((segment) => JWT_SEGMENT.test(segment));
     ```
     And fails to check `isJsonResponse(r)` or `body.user.name === owner.name`!
     Live probe proof (`PROBE 2B`):
     ```text
     PROBE 2B (undefined.undefined.undefined on refresh): {
       exitCode: 0,
       refreshCheck: { fails: 0, passes: 3, name: "refresh returns {user, token}" },
     }
     ```
     Returning `"undefined.undefined.undefined"` (or an expired token, an `HS512` token, or another user's token) from `POST /api/auth/refresh` passes `messages.load.ts` 100%!
- **Expected Behavior**:
  Use `isIsoTimestamp` in `messages.load.ts` (`hasErrorShape`), validate refreshed and setup JWTs with `hasUsableClaims(token, id, name)` + `isJsonResponse(r)` + `body.user.name === owner.name`, and add per-field error-shape and JWT-claim sabotage probes to `messages.load.sabotage.test.ts`.

---

### BUG-HIGH-04: 15 Surviving Stryker Mutants in `MisorderedMessageRepository` (`fake-messages-server.ts:106-138`), Dead `'history pages hold at most the limit'` Check, and 5 Cascading False Check Failures in `no-ack`

- **Classification**: White-Box / Stryker Mutant Survival & Coupled Sabotage Assertions.
- **Target**:
  - [fake-messages-server.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/support/fake-messages-server.ts#L106-L140)
  - [messages.load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.ts#L538-L613)
  - [messages.load.sabotage.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.sabotage.test.ts#L67-L97)
- **How It Was Attacked**:
  Ran `@stryker-mutator/core` on `test/load/support/fake-messages-server.ts` against `test/load/messages.load.sabotage.test.ts` and ran `PROBE 3` comparing `failedChecks` of `history-ascending`, `history-overlap`, and `no-ack`.
- **What Failed & How It Failed**:
  1. **15 Mutants Survived in `MisorderedMessageRepository` & `messageRepositoryFor` (`fake-messages-server.ts:115-138`)**:
     ```diff
     [Survived] ConditionalExpression
     test/load/support/fake-messages-server.ts:115:9
     - if (this.mode === 'ascending') {
     + if (true) {

     [Survived] ConditionalExpression
     test/load/support/fake-messages-server.ts:115:9
     - if (this.mode === 'ascending') {
     + if (false) {

     [Survived] BlockStatement
     test/load/support/fake-messages-server.ts:115:36
     - if (this.mode === 'ascending') {
     -   const rows = await super.page(roomId, query);
     -   return rows.toReversed();
     - }
     + if (this.mode === 'ascending') {}

     [Survived] MethodExpression
     test/load/support/fake-messages-server.ts:126:12
     - return rows.filter((message) => before === null || message.id <= before).slice(0, query.limit);
     + return rows.slice(0, query.limit);
     ```
     Why did deleting `if (this.mode === 'ascending')`, swapping `ascending` and `overlap`, or ignoring `before` altogether (`return rows.slice(0, query.limit)`) survive?
     - In `history-ascending`, reversing each page (`[m4, m5]`) causes `HistoryUseCase` to pick `nextBefore = page.at(-1).id = m5`, so page 2 returns `[m3, m4]`, duplicating `m4`!
     - In `history-overlap`, the inclusive cursor (`message.id <= before`) repeats `m4` at the boundary (`[m5, m4, m4, m3, ...]`), and in `messages.load.ts:583`, `id < (all[index - 1] ?? '')` evaluates `m4 < m4` (`false`)!
     - Consequently, **both sabotages fail the exact same 3 checks**:
       ```text
       PROBE 3 (history-ascending vs history-overlap failedChecks): {
         ascending: [ "history is newest first", "history pages are complete", "history pages are disjoint" ],
         overlap:   [ "history is newest first", "history pages are complete", "history pages are disjoint" ],
       }
       ```
     - Because `messages.load.sabotage.test.ts:90` only asserts `expect(failedChecks(outcome)).toContain(name)`, `history-ascending` and `history-overlap` are completely interchangeable!
  2. **Dead Check `'history pages hold at most the limit'` & False-Pass on `'history pages are disjoint'` (`messages.load.ts:586-588`)**:
     - `HistoryUseCase.execute` (`src/backend/messaging/application/messaging.history.use-case.ts:44`) always slices `rows.slice(0, limit)`, so a repository sabotage in `fake-messages-server.ts` can never produce a page larger than `HISTORY_PAGE` (`2`).
     - In `messages.load.ts:586`:
       `'history pages are disjoint': () => new Set(all).size === all.length`
       When `readHistory()` returns `null` (e.g., on `429` or `500`), `all` is `[]`, and `new Set([]).size === [].length` (`0 === 0`) evaluates to **`true`**, false-passing `'history pages are disjoint'` on a failed request!
  3. **Cascading False Failures & 44.9s Timeout in `no-ack` (`messages.load.ts:555-573`)**:
     In `fanOut` (`messages.load.ts:568`):
     ```ts
     check(delivered, {
       "message.new reaches the other member": (frame) =>
         frame !== null && messageOf(frame)?.id === stored?.id,
     });
     ```
     When `no-ack` drops `message.ack`, `ack` is `null` (`stored?.id` is `undefined`), even though `message.new` **did** reach `receiver`! Comparing `messageOf(delivered)?.id === undefined` causes `'message.new reaches the other member'` to false-fail `15/15` times, leaves `ids = []` (`ids.at(-1) === undefined`), sends `{ kind: 'read', messageId: undefined }` (causing `'read receipt reaches the sender'` and `'receipts advance to the read message'` to false-fail), and fails `'history pages are complete'` (`42` failed checks across 6 check names, taking `44.9s`!).
- **Expected Behavior**:
  1. Decouple `history-ascending` (e.g., return all messages in ascending order across non-overlapping pages at the controller/use-case level) from `history-overlap` (and check intra-page descending order or `id <= prev` so overlap alone does not fail `'history is newest first'`), add an oversized-page sabotage for `'history pages hold at most the limit'`, and require `list !== null` in `'history pages are disjoint'` and `'history pages are complete'`.
  2. In `fanOut`, fallback to `const messageId = stored?.id ?? messageOf(delivered)?.id` so `no-ack` fails **only** `'send is acked with the stored message'` (and `'retry is acked as a duplicate of the original'`), and assert exact `failedChecks(outcome).toEqual([...checks])` in `messages.load.sabotage.test.ts`.

---

### BUG-HIGH-05: 22 Surviving Stryker Mutants in `fake-messages-server.ts` Allow `500 Internal Server Error` Crashes to Masquerade as `non-member-history` and Leave Server Stop/Drain Unverified

- **Classification**: White-Box / Stryker Mutant Survival & Loose Test Assertions.
- **Target**:
  - [fake-messages-server.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/support/fake-messages-server.ts#L158-L271)
  - [messages.load.sabotage.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/messages.load.sabotage.test.ts#L67-L97)
- **How It Was Attacked**:
  Inspected the remaining 22 surviving mutants from `@stryker-mutator/core` on `test/load/support/fake-messages-server.ts`.
- **What Failed & How It Failed**:
  1. **Emptying `history.execute` in `non-member-history` Survived (`fake-messages-server.ts:161-165`)**:
     ```diff
     [Survived] BlockStatement
     test/load/support/fake-messages-server.ts:161:58
     - history.execute = async (actor, rawRoomId, query) => {
     -   const roomId = RoomId.create(rawRoomId);
     -   const room = roomId.ok ? await rooms.findById(roomId.value) : null;
     -   return execute(room?.memberIds[0] ?? actor, rawRoomId, query);
     - };
     + history.execute = async (actor, rawRoomId, query) => {};
     ```
     When `history.execute` returns `undefined`, `resultResponse` throws `TypeError: undefined is not an object (evaluating 'result.ok')`, which `respond()` turns into a `500 Internal Server Error` for **every** history call (both `outsider` in `rest()` and `owner` in `live()`).
     Because `messages.load.sabotage.test.ts:76` & `90` only checks:
     `expect(failedChecks(outcome)).toContain('non-member history is 403')`
     and `expect(crossed(outcome, 'http_req_failed')).toBe(true)`, a `500` crash on every history call passes the `non-member-history` test!
  2. **Emptying `stop()` in `fake-messages-server.ts:227-230` Survived**:
     ```diff
     [Survived] BlockStatement
     test/load/support/fake-messages-server.ts:227:23
     - stop: async () => {
     -   await gateway.drain();
     -   await server.stop(true);
     - },
     + stop: async () => {},
     ```
     No test verifies that `server.stop()` actually closes the listening port and drains active WebSocket connections.
  3. **Removing `if (original.status !== 429)` in `stripRetryAfter` (`fake-messages-server.ts:237`) Survived**:
     ```diff
     [Survived] ConditionalExpression
     test/load/support/fake-messages-server.ts:237:7
     - if (original.status !== 429) {
     -   return original;
     - }
     + if (false) {}
     ```
     The early-return guard in `stripRetryAfter` is redundant because non-429 responses have no `retry-after` header.
- **Expected Behavior**:
  Assert `expect(failedChecks(outcome).toSorted()).toEqual([...checks].toSorted())` in `messages.load.sabotage.test.ts` (so `non-member-history` cannot break member history in `live()`), remove the redundant `if (original.status !== 429)` guard in `stripRetryAfter`, and verify `server.stop()` closes the server.

---

### BUG-HIGH-06: `load.orchestrator.ts` Surviving Mutants Mask `messages.load.ts` Failures When `auth.load.ts` Passes (`exits = [0, 99]`), Overwrite `k6Code` on Cleanup Failure, and Skip `resetRateLimits` When Cleanup Throws

- **Classification**: White-Box / Stryker Mutant Survival & Orchestrator Control-Flow Bugs.
- **Target**:
  - [load.orchestrator.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/load.orchestrator.ts#L90-L152)
  - [load.orchestrator.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/load.orchestrator.test.ts#L67-L195)
- **How It Was Attacked**:
  Ran `@stryker-mutator/core` on `test/load/load.orchestrator.ts` and executed `PROBE 4` on `runLoad`.
- **What Failed & How It Failed**:
  1. **`messages.load.ts` Failure Masked When `auth.load.ts` Passes (`load.orchestrator.ts:126`)**:
     ```diff
     [Survived] ConditionalExpression
     test/load/load.orchestrator.ts:126:39
     - const k6Code = codes.find((code) => code !== 0) ?? 0;
     + const k6Code = codes.find((code) => true) ?? 0;
     ```
     In `load.orchestrator.test.ts:101`, the only multi-suite failure test uses `const exits = [99, 0]` (where the first suite `auth.load.ts` fails and the second suite `messages.load.ts` passes). There is **no test for `exits = [0, 99]`** (where `auth.load.ts` passes `0` and `messages.load.ts` fails `99`)! Mutating `codes.find((code) => code !== 0)` to `codes.find(() => true)` (`codes[0]`) survives and causes `bun run test:load smoke all` to exit `0` when `messages.load.ts` fails!
  2. **`k6Code` (`99`) Overwritten With `1` When Cleanup Also Fails (`load.orchestrator.ts:133`)**:
     ```diff
     [Survived] ConditionalExpression
     test/load/load.orchestrator.ts:133:12
     - return k6Code === 0 && !cleaned ? 1 : k6Code;
     + return true && !cleaned ? 1 : k6Code;
     ```
     Line 139 comments: `/** True when the run's data is gone; a failure is logged, never thrown, so it cannot hide k6's code. */`
     Yet no test exercises `k6Code = 99` together with a failing `cleanup`, so mutating `k6Code === 0` to `true` survives and hides `99` behind `1`.
  3. **`cleanUp()` Skips `resetRateLimits(userIds)` Whenever `deps.cleanup(runId)` Throws (`load.orchestrator.ts:141-145`)**:
     ```ts
     try {
       const userIds = await deps.runUserIds(runId);
       const removed = await deps.cleanup(runId);
       await deps.resetRateLimits(userIds);
     ```
     Live probe proof (`PROBE 4A`):
     ```text
     PROBE 4A (when cleanup throws, resetRateLimits(userIds) is skipped): {
       calls: [ "resetRateLimits([])", "cleanup threw" ],
       code: 1,
     }
     ```
     When `deps.cleanup(runId)` throws, `deps.resetRateLimits(userIds)` is never called, leaving the loopback IP buckets (`rl:ip:127.0.0.1`, etc.) and user buckets (`rl:user:<id>`) exhausted in Valkey!
  4. **Redundant `resetRateLimits([])` After `SIGINT` & Untested `running.container !== null` Guard (`load.orchestrator.ts:91-107`)**:
     - When `SIGINT` interrupts `auth.load.ts`, the next iteration of `for (const script of plan.scripts)` calls `await deps.resetRateLimits([])` (line 103) **before** checking `if (signals.interrupted !== null) break;` (line 105).
     - `const running = { container: null }` -> `{}` (line 91) and `if (running.container !== null)` -> `if (true)` (line 94) both survived Stryker because `load.orchestrator.test.ts:174-194` never asserts that `stopContainer` was **not** called when a signal arrived while `running.container === null` (or after a container exited).
     - `export function usage(): string {}` (line 55) also survived with 0% unit test coverage.
- **Expected Behavior**:
  Check `if (signals.interrupted !== null) break;` at the start of the suite loop before `resetRateLimits([])`, run `resetRateLimits(userIds)` in a `finally` block inside `cleanUp` even if `deps.cleanup(runId)` throws, and add unit tests in `load.orchestrator.test.ts` for `exits = [0, 99]`, `k6Code = 99` + failing cleanup, `stopContainer` not called when `running.container === null`, and `usage()`.

---

### BUG-HIGH-07: `runUserIds` in `load.cleanup.ts` Has 0% Test Coverage (100% Mutant Survival), and `deleteRunData` Rolls Back All Cleanup If a Load User Is in a 2-Member Foreign Room

- **Classification**: White-Box / Database Cleanup Atomicity & Untested Export.
- **Target**:
  - [load.cleanup.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/load.cleanup.ts#L23-L53)
  - [load.cleanup.integration.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/integration/load.cleanup.integration.test.ts#L82-L223)
- **How It Was Attacked**:
  Ran `@stryker-mutator/core` on `test/load/load.cleanup.ts` against `test/integration/load.cleanup.integration.test.ts` and `test/integration/load.rate-limit-reset.integration.test.ts`.
- **What Failed & How It Failed**:
  1. **`runUserIds` Body Deletion Survived (`test/load/load.cleanup.ts:48-53`)**:
     ```diff
     [Survived] BlockStatement
     test/load/load.cleanup.ts:48:78
     - export async function runUserIds(sql: SQL, runId: string): Promise<number[]> {
     -   const rows = await sql<
     -     Array<{ id: number }>
     -   >`SELECT id FROM users WHERE name ~ ${runUserPattern(runId)}`;
     -   return rows.map((row) => row.id);
     - }
     + export async function runUserIds(sql: SQL, runId: string): Promise<number[]> {}
     ```
     Neither `load.cleanup.integration.test.ts` nor `load.rate-limit-reset.integration.test.ts` ever calls `runUserIds(sql, runId)`! If `runUserIds` is broken or returns `[]`, per-user rate-limit keys `rl:user:<id>` are never cleaned up in Valkey.
  2. **All-or-Nothing Transaction Rollback in `deleteRunData` (`test/load/load.cleanup.ts:25-41`)**:
     If any single load user (`load<runId>m0`) was added to a foreign user's room and that room has 2 members at cleanup time (for example, a 3-member room `[foreign1, foreign2, loadUser]` where `foreign2` left), `rooms_min_members_on_leave` (`SQLSTATE 23514`) fires at `COMMIT` and **rolls back the deletion of all 29 load users (`p0..p19`, `u0..u9`, `m0..m8`) and all rooms/messages created by the run**.
- **Expected Behavior**:
  Add direct integration tests for `runUserIds(sql, runId)` in `test/integration/load.cleanup.integration.test.ts` (verifying it returns the exact IDs of `p`, `u`, and `m` users of `runId`, rejects malformed `runId`s before querying, and ignores foreign users).

---

### BUG-MEDIUM-08: `newRunId()` Entropy Multiplication Mutant (`byte * 36`) Survived in `k6-runner.ts:32`, and `scripts/load.ts` (`33.93%` Mutation Score) Leaks Uncancelled `Bun.sleep(5_000)` Timers in `withTimeout`

- **Classification**: White-Box / Stryker Mutant Survival & Timer Resource Leak.
- **Target**:
  - [k6-runner.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/k6-runner.ts#L28-L35)
  - [k6-runner.run-id.test.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/test/load/k6-runner.run-id.test.ts#L23-L44)
  - [load.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/scripts/load.ts#L20-L85)
- **How It Was Attacked**:
  Ran `@stryker-mutator/core` on `test/load/k6-runner.ts` and `scripts/load.ts`.
- **What Failed & How It Failed**:
  1. **`(byte % 36).toString(36)` -> `(byte * 36).toString(36)` Survived (`test/load/k6-runner.ts:32`)**:
     ```diff
     [Survived] ArithmeticOperator
     test/load/k6-runner.ts:32:6
     - (byte % 36).toString(36),
     + (byte * 36).toString(36),
     ```
     When `byte % 36` is mutated to `byte * 36`, `(byte * 36).toString(36)` produces `2` or `3` characters ending in `'0'` per byte (`16..24` characters instead of `RUN_ID_ENTROPY = 8`). Because `k6-runner.run-id.test.ts:42` only checks `expect(\`load\${newRunId()}u9999\`.length).toBeLessThanOrEqual(64)`instead of asserting the exact`RUN_ID_ENTROPY` suffix length (`time.length + 8`), the mutant survived.
  2. **`scripts/load.ts` Has 37 Surviving Mutants (`33.93%` Score) & Leaks `Bun.sleep(5_000)` Timers (`scripts/load.ts:76-85`)**:
     ```ts
     async function withTimeout(pending: Promise<unknown>): Promise<boolean> {
       const timeout = Bun.sleep(PREFLIGHT_TIMEOUT_MS).then(() => false);
       return Promise.race([
         pending.then(
           () => true,
           () => false,
         ),
         timeout,
       ]);
     }
     ```
     - Every call to `withTimeout` (`sql\`SELECT 1\``and`cache.send('PING', [])`) starts an uncancelled 5,000 ms `Bun.sleep`timer that remains pending after`pending`resolves in`<1 ms`.
     - Furthermore, `withTimeout` and `preflight` live inside `scripts/load.ts` (which executes `process.exitCode = await main()` on import) rather than `test/load/load.orchestrator.ts`, leaving all 37 mutants in `scripts/load.ts` (`withTimeout`, `preflight`, `cache.close()`, `await sql.close()`, `LOAD_BASE_URL` fallback) completely untested.
- **Expected Behavior**:
  Assert the exact length of `newRunId()` (`before.toString(36).length + 8` or `after.toString(36).length + 8`) in `k6-runner.run-id.test.ts`, move `withTimeout` and `createPreflight` into `test/load/load.orchestrator.ts` (clearing the timer in `finally` with `clearTimeout`), and unit-test them in `load.orchestrator.test.ts`.

---

## 2. Stryker Mutation Testing Summary on `test/load` & `scripts/load.ts`

Commands executed (via `bunx --bun @stryker-mutator/core` without modifying repository files):

1. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --concurrency 2 --testRunner command --commandRunner.command "bun test ./test/load/k6-runner.test.ts ./test/load/k6-runner.run-id.test.ts ./test/load/load.orchestrator.test.ts ./test/integration/load.cleanup.integration.test.ts ./test/integration/load.rate-limit-reset.integration.test.ts -t '^(?!.*stopContainer)'" --coverageAnalysis off --mutate "test/load/k6-runner.ts,test/load/load.cleanup.ts,test/load/load.orchestrator.ts,scripts/load.ts" --reporters clear-text`
2. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --concurrency 3 --testRunner command --commandRunner.command "bun test ./test/load/messages.load.sabotage.test.ts -t '^(?!.*no-ack)'" --coverageAnalysis off --mutate "test/load/support/fake-messages-server.ts" --reporters clear-text`

| File                                        | Mutation Score | Total Mutants | Killed / Timeout | Survived | Key Surviving Mutants                                                                                                                                                                        |
| :------------------------------------------ | :------------: | :-----------: | :--------------: | :------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/load.ts`                           |   **33.93%**   |      56       |        19        |  **37**  | `withTimeout`, `preflight`, `onSignal`, `cache.close()`, `await sql.close()`, `LOAD_BASE_URL` fallback                                                                                       |
| `test/load/k6-runner.ts`                    |   **60.98%**   |      41       |        25        |  **16**  | `(byte * 36).toString(36)` in `newRunId()`, `runK6` Podman shell arguments (tested by k6 probes)                                                                                             |
| `test/load/support/fake-messages-server.ts` |   **67.26%**   |      113      |    76 (73+3)     |  **37**  | All 15 mutants in `MisorderedMessageRepository` (`history-ascending` vs `history-overlap`), `history.execute = async () => {}`, `storeSenderKeys.execute = async () => {}`, `stop: () => {}` |
| `test/load/load.orchestrator.ts`            |   **92.63%**   |      95       |        88        |  **7**   | `codes.find(() => true)`, `return true && !cleaned ? 1 : k6Code`, `if (running.container !== null)` -> `if (true)`, `usage()`, `stopContainer`                                               |
| `test/load/load.cleanup.ts`                 |   **93.75%**   |      16       |        15        |  **1**   | `runUserIds` entire function body replaced with `{}`                                                                                                                                         |
| **Total Instrumented Host Files**           |   **69.47%**   |    **321**    |     **223**      |  **98**  | **98 surviving mutants across the `messages` load harness**                                                                                                                                  |

---

## 3. Recommended Action Plan

1. **Harden `messages.load.ts` Checks & Protocol Coverage (`BUG-CRITICAL-01`, `BUG-CRITICAL-03`, `BUG-HIGH-04`)**:
   - Replace `new Date(timestamp).toISOString() === timestamp` in `messages.load.ts:157` with `isIsoTimestamp(timestamp)`.
   - Validate JWT claims (`alg === 'HS256'`, `sub === String(id)`, `name`, `exp`) and `Content-Type: application/json` on `POST /api/auth/refresh` and `setup()` `signUp`.
   - Fix `fanOut` (`messages.load.ts:568`) so `no-ack` does not cascade into 5 unrelated false-failing checks, and guard `'history pages are disjoint'` and `'history pages are complete'` with `list !== null`.
   - Add one-defect sabotages in `fake-messages-server.ts` and `messages.load.sabotage.test.ts` (asserting exact `.toEqual` on `failedChecks(outcome)`) to cover all `check()` assertions and decouple `history-ascending` from `history-overlap`.
2. **Align `IP_POLICY` Between `fake-messages-server.ts` and the Real Server (`BUG-CRITICAL-02`)**:
   - Stop faking `IP_POLICY = { capacity: 100_000, refillPerSecond: 100_000 }` in `fake-messages-server.ts`, or calibrate `messages.load.ts` `stress` so `fake-messages-server.ts` (`honest`) and the real server behave identically.
3. **Fix `load.orchestrator.ts`, `load.cleanup.ts`, `k6-runner.ts`, and `scripts/load.ts` (`BUG-HIGH-06`, `BUG-HIGH-07`, `BUG-MEDIUM-08`)**:
   - Check `if (signals.interrupted !== null) break;` before `resetRateLimits([])` in `runLoad`, and run `resetRateLimits(userIds)` even when `deps.cleanup(runId)` throws.
   - Add tests for `exits = [0, 99]`, `k6Code = 99` + failing cleanup, `stopContainer` not called when `running.container === null`, `usage()`, `runUserIds()`, and exact `newRunId()` length (`time.length + 8`).
   - Extract `withTimeout` (with `clearTimeout` cleanup) and `createPreflight` into `test/load/load.orchestrator.ts` and unit-test them.
