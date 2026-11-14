# Adversarial QA & Mutation Testing Report — Load Testing (`test/load/` & `scripts/load.ts`) — Run 3 (`messages`, `sign-out`, `auth-hardening`)

- **Target Scope**:
  - `test/load/messages.load.ts` (532 lines)
  - `test/load/auth.load.ts` (436 lines)
  - `test/load/support/fake-messages-server.ts` (228 lines)
  - `test/load/support/fake-auth-server.ts` (279 lines)
  - `test/load/support/k6-probe.test-support.ts` (115 lines)
  - `test/load/messages.load.sabotage.test.ts` (167 lines)
  - `test/load/auth.load.sabotage.test.ts` (114 lines)
  - `test/load/auth.load.jwt-claims.sabotage.test.ts` (90 lines)
  - `test/load/auth.load.rate-limit.sabotage.test.ts` (98 lines)
  - `test/load/k6-runner.ts` (175 lines)
  - `test/load/load.cleanup.ts` (172 lines)
  - `test/load/load.orchestrator.ts` (128 lines)
  - `scripts/load.ts` (118 lines)
  - `test/integration/load.cleanup.integration.test.ts` (223 lines)
  - `test/integration/load.rate-limit-reset.integration.test.ts` (77 lines)
- **Role**: Adversarial QA & Mutation Analyst (Strictly Read-Only on `*.ts` / `*.test.ts`)
- **Methodology**:
  1. Static protocol, concurrency, rate-limit, cookie/session, and cleanup analysis across `test/load/` and `scripts/load.ts`, explicitly auditing the new features introduced in `odd/tasks/sign-out.md` and `odd/tasks/auth-hardening.md`.
  2. Live adversarial k6 probes against `messages.load.ts`, `auth.load.ts`, `fake-messages-server.ts`, `fake-auth-server.ts`, and `load.orchestrator.ts`.
  3. `@stryker-mutator/core` v9.6.0 mutation runs on `test/load/k6-runner.ts`, `test/load/load.cleanup.ts`, `test/load/load.orchestrator.ts`, `scripts/load.ts`, and `test/load/support/fake-messages-server.ts`.

---

## Fix Status (2026-11-14)

Tracked in `odd/tasks/load-run3-bugs.md`. Seam check: `bun run verify` (686 pass), `bun run test:integration` (100 pass), `bun run test:e2e` (83 pass), `bun run test:load:probes` (169 pass).

| ID                      | Status                                                                                                                                                                                                                                                                                   |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUG-LOAD-RUN3-CRIT-01` | Fixed: the fake models `signin:<name>` with the default policy; `auth.load.ts` walks the pool (80 names on `load`); `resetRateLimits` refills `rl:signin:load<runId>*`.                                                                                                                  |
| `BUG-LOAD-RUN3-CRIT-02` | Fixed: the fake uses the default IP/user/sign-in policies; the `stress` burst starts after `live`/`rest`. Not yet run against the real server.                                                                                                                                           |
| `BUG-LOAD-RUN3-CRIT-03` | Fixed: `sid`/`sst` checked; refresh checks claims, cookie attributes and the hint; one cookie-only request.                                                                                                                                                                              |
| `BUG-LOAD-RUN3-CRIT-04` | Fixed, except the sign-out upgrade race (S6), which stays pinned by e2e tests.                                                                                                                                                                                                           |
| `BUG-LOAD-RUN3-HIGH-01` | Fixed: guarded ISO check; later `rest()` checks still run.                                                                                                                                                                                                                               |
| `BUG-LOAD-RUN3-HIGH-02` | Fixed: every listed check has a sabotage; hint `Max-Age`, `SameSite=Strict` and `Path=/` added.                                                                                                                                                                                          |
| `BUG-LOAD-RUN3-HIGH-03` | Fixed: history sabotages fail distinct, exactly asserted sets; a 500 on non-member history is caught.                                                                                                                                                                                    |
| `BUG-LOAD-RUN3-HIGH-04` | Fixed: steps after a send use the broadcast id when the ack is missing.                                                                                                                                                                                                                  |
| `BUG-LOAD-RUN3-MED-01`  | Fixed: buckets are refilled even when the cleanup fails, no reset after a signal, `withTimeout` clears its timer, the load script reads `loadConnectionConfig` (no `JWT_SECRET`). Not reproduced (code no longer exists): `parseLoadArgs` `'--'` branches, `if (k6Code === 0) log.info`. |
| `BUG-LOAD-RUN3-MED-02`  | Fixed: tests for `runUserIds`, the run-id alphabet and trailing junk kill the reported mutants. Not reproduced: `namePrefixOf`, `stepFailed` (the anchor lives in `RUN_ID_PATTERN`).                                                                                                     |

## Executive Summary

| Severity     | ID                      | File & Line                                                                                                      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :----------- | :---------------------- | :--------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CRITICAL** | `BUG-LOAD-RUN3-CRIT-01` | `test/load/auth.load.ts:356-393`, `test/load/support/fake-auth-server.ts:207`, `test/load/load.cleanup.ts:59-68` | **New `auth-hardening` S7 Per-Account Throttle (`signin:<name>`, capacity 10, refill 1/30s) Breaks `auth.load.ts` (`load` Profile & `L-02` `pool-exists` Rerun) Against the Real Server, Goes Unmodeled in `fake-auth-server.ts`, and Goes Uncleaned in `resetRateLimits`**: `rejections()` and `signIn()` hammer `data.pool[0]` (`load<runId>p0`) with `[401]` / `[200]` expectations. After 10 attempts (~8s into `load`, or on the 2nd `smoke` run of `L-02` `pool-exists`), `SignInUseCase` answers `429 Too Many Requests`, failing `wrong password is 401`, `checks`, and `http_req_failed` (`exitCode = 99`). `resetRateLimits` never deletes `rl:signin:load<runId>*` keys in Valkey (5-minute TTL).                                            |
| **CRITICAL** | `BUG-LOAD-RUN3-CRIT-02` | `test/load/messages.load.ts:75-120`, `test/load/support/fake-messages-server.ts:73-77,209`                       | **`messages.load.ts` `stress` Profile Fails Against the Real Server (`exitCode = 99`, `http_req_failed = 15.26%`, `checks = 84.86%`) Because `fake-messages-server.ts` Disables Both the IP Bucket (`100,000`) and the Sign-In Bucket (`1,000`)**: Live k6 `stress` run against the real default `IP_POLICY` (`capacity: 120, refillPerSecond: 20`) sheds `live` (`POST /api/rooms`) and `rest` requests with `429`, failing 8 of 27 checks and crossing both `checks` and `http_req_failed` thresholds.                                                                                                                                                                                                                                                |
| **CRITICAL** | `BUG-LOAD-RUN3-CRIT-03` | `test/load/auth.load.ts:206-256`, `test/load/messages.load.ts:212-227,392-403`                                   | **Broken `auth-hardening` S3/S4 Session Cookie & JWT Claim Verification in `auth.load.ts` and `messages.load.ts`**: (1) `hasUsableClaims` in `auth.load.ts:206-228` never checks the mandatory `sid` or `sst` claims required by `JoseTokenVerifier.verify` (`user.security.jose.ts:74-78`), so a server issuing `sid`-less/`sst`-less JWTs passes `auth.load.ts` (`exitCode = 0`) while every protected route rejects the token with `401`. (2) `messages.load.ts:392-403` (`POST /api/auth/refresh`) still accepts `Set-Cookie: chat_rsa_session=undefined.undefined.undefined` without `HttpOnly`, `Secure`, `Max-Age`, `SameSite=Strict`, or `chat_rsa_session_hint`, and never tests cookie-based authentication (`Cookie: chat_rsa_session=...`). |
| **CRITICAL** | `BUG-LOAD-RUN3-CRIT-04` | `test/load/messages.load.ts`, `test/load/auth.load.ts`                                                           | **0% Load & Sabotage Coverage of New `sign-out` and `auth-hardening` Endpoints & Security Controls**: Neither `auth.load.ts` nor `messages.load.ts` exercises `POST /api/auth/sign-out` (`204`, cookie clearing `Max-Age=0`, Valkey `revoked-session:<sid>`, closing `/ws` sockets with `4001`, `S6` upgrade race), `GET /api/rooms/:roomId/members` (`sign-out.md` T3a), `auth.refreshed { expiresAt }` WebSocket push on HTTP refresh (`auth-hardening.md` S4), `auth.refresh` WebSocket frame, or CSRF `Origin` enforcement (`APP_ORIGINS`, `403` on untrusted `Origin` or cookie-authenticated unsafe request without `Origin`).                                                                                                                    |
| **HIGH**     | `BUG-LOAD-RUN3-HIGH-01` | `test/load/messages.load.ts:159`                                                                                 | **Uncaught `RangeError: Invalid time value` in `hasErrorShape` Aborts the Entire `rest()` Iteration**: `new Date(timestamp).toISOString()` throws `RangeError` when an error response contains a non-date string (e.g., `"yesterday"`), aborting `rest()` mid-iteration before `GET /api/rooms/:id/receipts` and `POST /api/auth/refresh` ever execute. (`auth.load.ts:273` fixed this with `Number.isFinite(Date.parse(timestamp))`, but `messages.load.ts:159` was never updated.)                                                                                                                                                                                                                                                                    |
| **HIGH**     | `BUG-LOAD-RUN3-HIGH-02` | `test/load/messages.load.sabotage.test.ts:52-166`, `test/load/auth.load.sabotage.test.ts:68-89`                  | **18 of 27 Checks in `messages.load.ts` (66.7%) and 4 of 7 Cookie Checks in `auth.load.ts:248-255` Have 0% Sabotage Coverage**: 18 checks in `messages.load.ts` are never sabotaged. In `auth.load.ts:248-255`, `token.secure === true`, `token.max_age === TOKEN_LIFETIME_SECONDS`, `readable.http_only === false`, and `readable.secure === true` have 0% sabotage coverage in `fake-auth-server.ts`, and `readable.max_age`, `SameSite=Strict`, and `Path=/` are not checked at all.                                                                                                                                                                                                                                                                 |
| **HIGH**     | `BUG-LOAD-RUN3-HIGH-03` | `test/load/support/fake-messages-server.ts:99-121,158`                                                           | **`MisorderedMessageRepository` Conflates `history-ascending` and `history-overlap` (15 Surviving Stryker Mutants) & `non-member-history` Masks `500` Crashes**: Both history sabotages fail the exact same 3 checks (`history is newest first`, `history pages are complete`, `history pages are disjoint`); `non-member-history` returns `200` instead of `500`, leaving `statuses: [403]` / `http_req_failed` untested on `500` crashes.                                                                                                                                                                                                                                                                                                             |
| **HIGH**     | `BUG-LOAD-RUN3-HIGH-04` | `test/load/messages.load.ts:471-531`                                                                             | **`live()` WebSocket `no-ack` Sabotage Triggers a Cascading 6-Check Failure**: When `message.ack` is dropped (`no-ack`), `sentId` stays `null`, skipping step 3 (`receipt.read`) and step 4 (`leave` + `join` + stale-epoch send) until the 800ms safety timer closes both sockets, failing 5 unrelated checks.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **MEDIUM**   | `BUG-LOAD-RUN3-MED-01`  | `test/load/load.orchestrator.ts:74-127`, `scripts/load.ts:26`                                                    | **Orchestrator & Runner Defects (10 Surviving Mutants in `load.orchestrator.ts`, 37 in `scripts/load.ts`)**: (1) If `cleanup()` throws in `finally`, `resetRateLimits(userIds)` is skipped entirely, leaving user buckets exhausted. (2) After `SIGINT` on `auth.load.ts`, `runLoad` still runs `resetRateLimits([])` for `messages.load.ts`. (3) `codes.find((code) => code !== 0)` and `if (k6Code === 0)` survive mutation in `load.orchestrator.unit.test.ts`. (4) `scripts/load.ts:26` calls `loadConfig()` outside `NODE_ENV=test`, crashing immediately on the repo's 9-char `.env` `JWT_SECRET` (`auth-hardening` S1) and leaking `setTimeout` handles in `withTimeout`.                                                                        |
| **MEDIUM**   | `BUG-LOAD-RUN3-MED-02`  | `test/load/load.cleanup.ts:71-79`, `test/load/k6-runner.ts:82`                                                   | **0% Test Coverage of `runUserIds()` in `load.cleanup.ts` (6 Surviving Mutants) & Unpinned `newRunId()` Distribution in `k6-runner.ts` (1 Surviving Mutant)**: `runUserIds(sql, runId)` has zero unit or integration tests; `byte % 36` -> `byte * 36` in `k6-runner.ts:82` survives because `ALPHABET[byte * 36] ?? 'a'` falls back to `'a'`.                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## Detailed Findings & Reproduction Proofs

### `BUG-LOAD-RUN3-CRIT-01`: `auth-hardening` S7 Per-Account Throttle (`signin:<name>`) Breaks `auth.load.ts` (`load` Profile & `L-02` `pool-exists` Rerun) Against the Real Server, Is Unmodeled in `fake-auth-server.ts`, and Is Uncleaned in `resetRateLimits`

#### 1. Root Cause Across Three Files

1. **`src/backend/user/application/user.sign-in.use-case.ts:38-41` (`auth-hardening` S7)**:
   Every call to `SignInUseCase.execute` (after credential format validation) spends a token from the per-account bucket `signin:${name.value}` with default policy `capacity: 10, refillPerSecond: 1 / 30` (1 token every 30 seconds, Valkey TTL 300 seconds) **before** checking the password hash, returning `429 Too Many Requests` when empty.
2. **`test/load/auth.load.ts:355-394`**:
   - `rejections(data)` (`lines 384-394`) sends `wrongPassword = post('/api/auth/sign-in', { name: data.pool[0], password: WRONG_PASSWORD }, [401])` on **every single iteration** (`expectedStatuses(401)` — does not expect `429`, and `check(wrongPassword, { 'wrong password is 401': (r) => hasErrorShape(r, 401, path) })` requires `401`).
   - `signIn(data)` (`lines 355-362`) also sends `post('/api/auth/sign-in', { name: data.pool[0], password: PASSWORD }, [200])` whenever `scenario.iterationInTest % 20 === 0`.
   - In the `load` profile (`120s`), `rejections` hits `data.pool[0]` **120 times** (`1 req/s`) and `signIn` hits `data.pool[0]` **30 times** (`5 req/s / 20 users`) = **150 sign-in attempts on `data.pool[0]` in 120 seconds**. Since `signin:<name>` only has `capacity: 10` and refills 4 tokens over 120s (14 tokens total), **~136 out of 150 requests for `data.pool[0]` return `429 Too Many Requests` starting at second ~8 of the `load` run**, failing `'wrong password is 401'`, `'sign-in status is 200'`, `'sign-in returns {user} and the session cookies'`, `checks` (`rate>0.99`), and `http_req_failed` (`rate<0.01`)!
   - Even in `smoke` (`5s`), Run 1 spends **6 of the 10 tokens** on `data.pool[0]` (1 in `signIn` + 5 in `rejections`). If `smoke` is re-run with the same `--run-id` (the exact `L-02` `pool-exists` recovery scenario), Run 2 spends token 7 in `setup()` (`409` -> `POST /api/auth/sign-in`), token 8 in `signIn`, tokens 9 and 10 in the first two `rejections` iterations, and then **fails on iterations 2, 3, and 4 of `rejections` with `429 Too Many Requests` (`wrong password is 401`: `✓ 2 / ✗ 3`, `exitCode = 99`)**!
3. **`test/load/support/fake-auth-server.ts:207` & `test/load/load.cleanup.ts:59-68`**:
   - `fake-auth-server.ts` only models `ipLimiter` (`IP_POLICY`) and **never models the `signin:<name>` bucket**, so `auth.load.sabotage.test.ts` (`L-02: pool-exists`) gives a false-green pass.
   - `resetRateLimits` in `test/load/load.cleanup.ts:59-68` only deletes `rl:ip:<ip>` and `rl:user:<id>` in Valkey — it **never deletes `rl:signin:load<runId>*`**, leaving `rl:signin:load<runId>p0` exhausted in Valkey for 5 minutes (`ttlMs = 300,000`).

#### 2. Live k6 Reproduction Proof (PROBE 5)

Running `auth.load.ts` (`smoke`) twice with the same `runId` against the real `SignInUseCase` wired with `loadConfig().rateLimit.signin` (`capacity: 10, refillPerSecond: 1/30`):

```text
PROBE 5 (real signin:<name> bucket across pool-exists rerun): {
  firstRunExitCode: 0,
  secondRunCrossedChecks: true,
  secondRunCrossedHttpReqFailed: true,
  secondRunExitCode: 99,
  secondRunFailedChecks: [ "wrong password is 401" ],
}
    checks
    ✗ 'rate>0.99' rate=95.00%
    http_req_failed
    ✗ 'rate<0.01' rate=3.75%
    ✗ wrong password is 401
      ↳  40% — ✓ 2 / ✗ 3
```

---

### `BUG-LOAD-RUN3-CRIT-02`: `messages.load.ts` `stress` Profile Fails Against the Real Server (`exitCode = 99`) Because `fake-messages-server.ts` Disables Both `IP_POLICY` and `signin` Rate Limits

#### 1. Root Cause

In `test/load/support/fake-messages-server.ts:73-77` and `206-210`:

```ts
const IP_POLICY = { capacity: 100_000, refillPerSecond: 100_000 };
...
signIn: new SignInUseCase(users, hasher, tokens, {
  limiter: new InMemoryRateLimiter(),
  policy: { capacity: 1000, refillPerSecond: 1000 },
}),
```

In production (`src/backend/shared/config/env.config.ts`), `IP_POLICY` is `{ capacity: 120, refillPerSecond: 20 }`. During the `stress` profile of `messages.load.ts`:

- `setup()` consumes **30 tokens** from `ip:127.0.0.1` (`9` sign-ups + `9` identity-key uploads + `4` room creations + `8` sender-key uploads).
- Then `burst` fires **120 `GET /api/rooms` requests**, `live` fires `POST /api/rooms` + `2x GET /ws` upgrades (`4 req/s` * 2s = 24 requests), and `rest` fires 12 HTTP requests per iteration (`2 req/s` * 2s = 48 requests) — all from the same loopback IP!
- Unlike `burst` (which accepts `[200, 429]`), `live` (`POST /api/rooms`, `statuses: [201]`) and `rest` (`statuses: [200]`, `[201]`, `[204]`, `[403]`) treat every `429` from the exhausted IP bucket as a hard HTTP failure and check failure.

#### 2. Live k6 Reproduction Proof (PROBE 1)

Running `messages.load.ts` (`stress`) against a server using the real `loadConfig().rateLimit.ip` (`capacity: 120, refillPerSecond: 20`):

```text
PROBE 1 (real IP_POLICY on stress): {
  crossedChecks: true,
  crossedHttpReqFailed: true,
  exitCode: 99,
  failedChecks: [
    "room is created with both members",
    "sender keys reach the recipient",
    "non-member history is 403",
    "receipts list every member",
    "refresh returns {user} and a fresh session cookie",
    "history is newest first",
    "history pages are complete",
    "history pages hold at most the limit"
  ],
}
```

k6 fails with `exitCode = 99` (`checks` rate `84.86%`, `http_req_failed` rate `15.26%`, 29 failed HTTP requests out of 190).

---

### `BUG-LOAD-RUN3-CRIT-03`: Broken `auth-hardening` S3/S4 Session Cookie & JWT Claim Verification in `auth.load.ts` and `messages.load.ts`

#### 1. `auth.load.ts:206-228` (`hasUsableClaims`) Ignores Mandatory `sid` and `sst` Claims (`auth-hardening` S3)

In `src/backend/user/infrastructure/user.security.jose.ts:69-80`, `JoseTokenVerifier.verify` rejects any JWT missing `sid` (non-empty `string`) or `sst` (finite `number`):

```ts
if (
  !Number.isInteger(userId) ||
  userId < 1 ||
  typeof payload.exp !== "number" ||
  typeof payload.name !== "string" ||
  typeof payload.sid !== "string" ||
  payload.sid === "" ||
  typeof payload.sst !== "number" ||
  !Number.isFinite(payload.sst)
) {
  return null;
}
```

Yet `hasUsableClaims` in `test/load/auth.load.ts:206-228` only checks `header.alg === 'HS256'`, `payload.sub`, `payload.name`, and `payload.exp > nowSeconds` — it **never checks `typeof payload.sid === 'string' && payload.sid.length > 0` or `typeof payload.sst === 'number' && Number.isFinite(payload.sst)`**!

- **Live k6 Reproduction Proof (PROBE 6)**: When an auth server issues HS256 tokens without `sid` or `sst`, `new JoseTokenVerifier(SECRET).verify(token)` returns `null` (`401` on every protected endpoint), yet `auth.load.ts` (`smoke`) passes with **`exitCode = 0` and `failedChecks = []`**!

#### 2. `messages.load.ts:392-403` (`POST /api/auth/refresh`) Accepts `"undefined.undefined.undefined"` and Ignores Cookie Attributes & Hint Cookie (`auth-hardening` S4)

In `test/load/messages.load.ts:392-403`:

```ts
const refreshed = api("POST", "/api/auth/refresh", { statuses: [200], token: sender.token });
check(refreshed, {
  "refresh returns {user} and a fresh session cookie": (res) => {
    const body = jsonBody(res);
    const user = body !== null && isRecord(body.user) ? body.user : null;
    const token = res.cookies[SESSION_COOKIE]?.[0]?.value;
    return (
      res.status === 200 &&
      isJson(res) &&
      body !== null &&
      !("token" in body) &&
      user?.id === sender.id &&
      user.name === sender.name &&
      typeof token === "string" &&
      token.split(".").length === 3 &&
      token.split(".").every((segment) => JWT_SEGMENT.test(segment))
    );
  },
});
```

- It **never decodes the refreshed JWT's header or payload** (`alg`, `sub`, `name`, `exp`, `sid`, `sst`), nor checks that `sid` and `sst` were preserved from `sender.token` (`auth-hardening` S3).
- It **never checks `http_only === true`, `secure === true`, or `max_age === 3600`** on `chat_rsa_session`.
- It **never checks that `chat_rsa_session_hint` is present or matches `String(payload.exp)`**.
- **Live k6 Reproduction Proof (PROBE 2B)**: When `POST /api/auth/refresh` returns `Set-Cookie: chat_rsa_session=undefined.undefined.undefined; Path=/` (no `HttpOnly`, no `Secure`, no `Max-Age`, no `chat_rsa_session_hint`, and non-JSON segments), `messages.load.ts` (`smoke`) exits with **`exitCode = 0` and `refreshCheck = { passes: 3, fails: 0 }`**!
- Furthermore, because `sessionCookies` sets `Secure` on `chat_rsa_session` over `http://localhost` and `messages.load.ts` passes `Authorization: Bearer <token>` on every `api()` call (`messages.load.ts:185-187`), **neither `auth.load.ts` nor `messages.load.ts` ever tests authenticating a subsequent request via `Cookie: chat_rsa_session=<jwt>`**.

---

### `BUG-LOAD-RUN3-CRIT-04`: 0% Load & Sabotage Coverage of New `sign-out` and `auth-hardening` Endpoints & Security Controls

Despite `odd/tasks/sign-out.md` and `odd/tasks/auth-hardening.md` adding new endpoints, WebSocket lifecycle events, and HTTP guard checks, `test/load/` has **0% load and sabotage coverage** for all of the following:

1. **`POST /api/auth/sign-out` (`sign-out.md` S1)**:
   - Returning `204 No Content` and clearing `chat_rsa_session` + `chat_rsa_session_hint` (`Max-Age=0`).
   - Revoking `sid` in Valkey (`revoked-session:<sid>`) so subsequent HTTP requests (`GET /api/rooms`), `POST /api/auth/refresh`, `/ws` upgrades, and `auth.refresh` socket frames with any token of that `sid` are rejected with `401` / close code `4001`.
   - Closing open `/ws` sockets of the revoked session with close code `4001`, including in-flight `/ws` upgrades (`auth-hardening.md` S6).
2. **`GET /api/rooms/:roomId/members` (`sign-out.md` T3a)**:
   - Mounted on `createMessagingController` (`src/backend/messaging/presentation/messaging.controller.ts`), wired in `fake-messages-server.ts:190` (`listRoomMembers: new ListRoomMembersUseCase(rooms, users)`), yet **never called anywhere in `test/load/messages.load.ts`**!
3. **`auth.refreshed` WebSocket Frame on HTTP Refresh & `auth.refresh` Client Frame (`auth-hardening.md` S4)**:
   - In `messages.load.ts`, `POST /api/auth/refresh` runs inside `rest()` where no WebSocket is open, so the `auth.refreshed { expiresAt }` server push to open sockets of that session is never exercised or asserted under load.
4. **CSRF `Origin` Guard (`auth-hardening.md` S4, `http.guard.ts:152-161`)**:
   - Unsafe methods (`POST`, `DELETE`) with an untrusted `Origin` header (`403 Forbidden`) or cookie-authenticated unsafe requests without an `Origin` header (`403 Forbidden`) have **0% load and sabotage coverage** in `auth.load.ts` and `messages.load.ts`.

---

### `BUG-LOAD-RUN3-HIGH-01`: Uncaught `RangeError: Invalid time value` in `messages.load.ts:159` (`hasErrorShape`) Aborts `rest()` Mid-Iteration

In `test/load/messages.load.ts:159`:

```ts
new Date(timestamp).toISOString() === timestamp;
```

In JavaScript / k6's Goja runtime, `new Date("yesterday").toISOString()` throws `RangeError: Invalid time value` instead of returning `false`. (`auth.load.ts:273` guarded this with `Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp`, but `messages.load.ts:159` did not.)

- **Live k6 Reproduction Proof (PROBE 2A)**: Returning `timestamp: "yesterday"` on the `403` response of `GET /api/rooms/:id/messages` throws an uncaught `RangeError` inside `rest()`, aborting the VU iteration so `'receipts list every member'` and `'refresh returns {user} and a fresh session cookie'` are **`undefined` (0 executions)**:

```text
time="2026-11-14T05:16:20Z" level=error msg="RangeError: Invalid time value\n\tat toISOString (native)\n\tat hasErrorShape (file:///scripts/messages.load.ts:159:36(81))"
PROBE 2A (bad timestamp on 403 in messages.load.ts): {
  exitCode: 99,
  nonMemberHistoryCheck: { fails: 3, passes: 0 },
  receiptsListCheck: undefined,
  refreshCheck: undefined,
}
```

---

### `BUG-LOAD-RUN3-HIGH-02`: 18 of 27 Checks in `messages.load.ts` (66.7%) and 4 of 7 Cookie Checks in `auth.load.ts:248-255` Have 0% Sabotage Coverage

#### 1. 18 Untested Checks in `test/load/messages.load.ts`

`test/load/support/fake-messages-server.ts` defines only **6** `MessagesSabotage` modes (`no-ack`, `no-broadcast`, `duplicate-inserted`, `history-ascending`, `history-overlap`, `non-member-history`), leaving **18 of 27 checks** in `messages.load.ts` with **0% sabotage test coverage**:

1. `'room is created with both members'` (`line 475`)
2. `'ws upgrade opens both sockets'` (`line 525`)
3. `'ready lists the room'` (`line 436`)
4. `'read receipt reaches the sender'` (`line 466`)
5. `'receipts advance to the read message'` (`line 506`)
6. `'a join rotates the epoch for live sockets'` (`line 513`)
7. `'a stale-epoch send is refused with conflict'` (`line 518`)
8. `'rooms list includes the new room'` (`line 301`)
9. `'user lookup returns {id, name}'` (`line 310`)
10. `'room keys list every member'` (`line 319`)
11. `'adding a member rotates the epoch'` (`line 331`)
12. `'leaving rotates the epoch'` (`line 340`)
13. `'sender-keys upload is 201'` (`line 356`)
14. `'sender keys reach the recipient'` (`line 362`)
15. `'history pages hold at most the limit'` (`line 277`)
16. `'receipts list every member'` (`line 381`)
17. `'refresh returns {user} and a fresh session cookie'` (`line 394`)
18. `'a burst is answered only with 200 or 429'` (`line 537`)

#### 2. 4 Untested Cookie Checks in `test/load/auth.load.ts:248-255` (`hasSessionCookies`)

In `test/load/auth.load.ts:248-255`:

```ts
return (
  token.http_only === true &&
  token.secure === true &&
  token.max_age === TOKEN_LIFETIME_SECONDS &&
  readable.http_only === false &&
  readable.secure === true &&
  payload !== null &&
  readable.value === String(payload.exp) &&
  hasUsableClaims(token.value, user)
);
```

`fake-auth-server.ts` only sabotages `'token-in-body'`, `'session-cookie-not-httponly'`, and `'hint-cookie-mismatch'`. It has **0% sabotage coverage** for:

1. `token.secure === true` (`chat_rsa_session` missing `Secure`)
2. `token.max_age === TOKEN_LIFETIME_SECONDS` (`chat_rsa_session` with wrong `Max-Age`)
3. `readable.http_only === false` (`chat_rsa_session_hint` marked `HttpOnly`, which breaks `src/frontend/auth/presentation/session-hint.ts` from reading `document.cookie`)
4. `readable.secure === true` (`chat_rsa_session_hint` missing `Secure`)
   And `hasSessionCookies` does not check `readable.max_age === TOKEN_LIFETIME_SECONDS`, `SameSite=Strict`, or `Path=/` at all.

---

### `BUG-LOAD-RUN3-HIGH-03` & `BUG-LOAD-RUN3-HIGH-04`: `fake-messages-server.ts` Sabotage Indistinguishability (`MisorderedMessageRepository`), `non-member-history` `500` Masking, and `live()` `no-ack` Cascade

1. **`MisorderedMessageRepository` (`fake-messages-server.ts:99-121`)**:
   - In `'history-overlap'`, `page.items.toReversed()` is returned on page 1 (`input.before === null`), which violates `'history is newest first'` (`first >= second`) and swaps the cursor `firstPage.nextCursor`, causing page 2 to miss messages (`'history pages are complete'` fails) in addition to overlapping (`'history pages are disjoint'` fails).
   - **Live k6 Reproduction Proof (PROBE 3)**: Both `'history-ascending'` and `'history-overlap'` fail the exact same 3 checks (`['history is newest first', 'history pages are complete', 'history pages are disjoint']`), yielding **15 surviving Stryker mutants** in `MisorderedMessageRepository`.
2. **`non-member-history` (`fake-messages-server.ts:158`)**:
   - Returns `Response.json({ items: [], nextCursor: null }, { status: 200 })`. Because `200` is only caught by the k6 check (`res.status === 403`) when `statuses: [403]` is overridden or checked, a `500 Internal Server Error` crash on `GET /api/rooms/:id/messages` is never tested.
3. **`live()` WebSocket `no-ack` Cascade (`messages.load.ts:471-531`)**:
   - Dropping `message.ack` leaves `sentId = null`, preventing step 3 (`receipt.read`) and step 4 (`leave` + `join` + stale-epoch send) from running and failing **6 checks simultaneously** (`send is acked with the stored message`, `read receipt reaches the sender`, `receipts advance to the read message`, `a join rotates the epoch for live sockets`, `a stale-epoch send is refused with conflict`, and `retry is acked as a duplicate of the original`).

---

### `BUG-LOAD-RUN3-MED-01` & `BUG-LOAD-RUN3-MED-02`: Orchestrator, Cleanup, Runner, and CLI Entrypoint Defects

1. **`test/load/load.orchestrator.ts:103-119`**:
   ```ts
   } finally {
     await dependencies.stopContainer(runId);
     try {
       const userIds = await dependencies.runUserIds(runId);
       await dependencies.cleanup(runId);
       await dependencies.resetRateLimits(userIds);
     } catch (error) {
       dependencies.log.error(error);
       cleanupFailed = true;
     }
   }
   ```
   - **Live Reproduction Proof (PROBE 4)**: When `dependencies.cleanup(runId)` throws (e.g., `rooms_min_members` constraint violation), `dependencies.resetRateLimits(userIds)` on line 107 is **skipped completely** (`calls = ['resetRateLimits([])', 'cleanup threw']`), leaving all user rate-limit buckets exhausted in Valkey!
   - When `interrupted` is set by `SIGINT` during the first suite (`auth.load.ts`), the loop still executes `await dependencies.resetRateLimits([])` for the second suite (`messages.load.ts`) before checking `if (interrupted)` on line 94.
2. **`scripts/load.ts:26` & `65-80`**:
   - `const config = loadConfig();` runs with `NODE_ENV` unset (`!== 'test'`). When `.env` has the 9-character `JWT_SECRET=secret123`, `bun run test:load` (`bun scripts/load.ts`) crashes immediately with `Error: JWT_SECRET must be set to at least 32 characters` (`auth-hardening` S1), even for `--cleanup-only`!
   - `withTimeout` (`scripts/load.ts:65-80`) never calls `clearTimeout` in a `.finally()` block, leaking a 15-second timer handle on every `stopContainer`, `runUserIds`, `deleteRunData`, and `resetRateLimits` call.
3. **`test/load/load.cleanup.ts:71-79` (`runUserIds`) & `test/load/k6-runner.ts:82` (`newRunId`)**:
   - `runUserIds(sql, runId)` has **0% unit and integration test coverage** (6 surviving Stryker mutants, including replacing its body with `{}`).
   - `ALPHABET[byte % 36] ?? 'a'` in `k6-runner.ts:82` survives mutation to `ALPHABET[byte * 36] ?? 'a'` because out-of-bounds indices evaluate to `undefined ?? 'a'`, silently collapsing the entropy of `newRunId()` whenever `byte > 0`!

---

## `@stryker-mutator/core` v9.6.0 Mutation Audit Results

### Summary Table

| Mutated File                                | Test Suite Executed                                                              | Killed | Timed Out | Survived | No Cov | Mutation Score |
| :------------------------------------------ | :------------------------------------------------------------------------------- | :----: | :-------: | :------: | :----: | :------------: |
| `test/load/k6-runner.ts`                    | `test/load/k6-runner.unit.test.ts`                                               |   53   |     0     |  **1**   |   0    |   **98.15%**   |
| `test/load/load.cleanup.ts`                 | `load.cleanup.integration.test.ts` + `load.rate-limit-reset.integration.test.ts` |   35   |     0     |  **2**   | **6**  |   **81.40%**   |
| `test/load/load.orchestrator.ts`            | `test/load/load.orchestrator.unit.test.ts`                                       |   48   |     0     |  **10**  |   0    |   **82.76%**   |
| `scripts/load.ts`                           | `test/load/*.unit.test.ts`                                                       |   20   |     0     |  **2**   | **35** |   **35.09%**   |
| `test/load/support/fake-messages-server.ts` | `test/load/messages.load.sabotage.test.ts` (targeted)                            |   —    |     —     |  **21**  |   —    | Audited below  |

### Surviving Mutants by File

#### 1. `test/load/k6-runner.ts` (1 Surviving Mutant — 98.15%)

- **Line 82 (`ArithmeticOperator`)**:
  ```diff
  - Array.from(bytes, (byte) => ALPHABET[byte % 36] ?? 'a').join('')
  + Array.from(bytes, (byte) => ALPHABET[byte * 36] ?? 'a').join('')
  ```
  _Why it survived_: `k6-runner.unit.test.ts` only checks `/^[a-z0-9]{10}$/` and uniqueness across 50 random IDs; with `byte * 36`, any `byte === 0` yields `'a'` and any `byte > 0` yields `undefined ?? 'a'`, producing `'aaaaaaaaaa'` unless tested for character distribution.

#### 2. `test/load/load.cleanup.ts` (8 Surviving / No-Coverage Mutants — 81.40%)

- **Lines 74–78 (`BlockStatement`, `StringLiteral`, `ArrayDeclaration` — 6 No-Coverage Mutants in `runUserIds`)**:
  ```diff
  export async function runUserIds(sql: SQL, runId: string): Promise<number[]> {
  -  const prefix = namePrefixOf(runId);
  -  const rows = await sql<Array<{ id: number }>>`
  -    SELECT id FROM users WHERE name LIKE ${`${prefix}%`}
  -  `;
  -  return rows.map((row) => row.id);
  +  {}
  }
  ```
  _Why they survived_: `runUserIds` is never called in `load.cleanup.integration.test.ts` or `load.rate-limit-reset.integration.test.ts`.
- **Line 82 (`Regex` — 1 Surviving Mutant in `namePrefixOf`)**:
  ```diff
  - if (!/^[a-z0-9]{6,32}$/u.test(runId)) {
  + if (!/^[a-z0-9]{6,32}/u.test(runId)) {
  ```
  _Why it survived_: `load.cleanup.integration.test.ts:216` only tests `'.*|x'` (which fails at index 0), never testing a valid prefix followed by SQL wildcard characters like `'abcdef0123%'`.
- **Line 153 (`StringLiteral` — 1 Surviving Mutant in `stepFailed`)**:
  ```diff
  - { cause: error, step }
  + { cause: error, step: "" }
  ```
  _Why it survived_: Tests only assert `String(rejection).toContain('minimum is 2')`, never asserting `error.step`.

#### 3. `test/load/load.orchestrator.ts` (10 Surviving Mutants — 82.76%)

- **Line 79 (`ConditionalExpression`, `ArrowFunction`, `EqualityOperator` — 3 Mutants)**:
  ```diff
  - return codes.find((code) => code !== 0) ?? 0;
  + return codes.find(() => true) ?? 0;
  ```
  _Why they survived_: In `load.orchestrator.unit.test.ts`, the only multi-script failure test fails on the **first** script (`auth.load.ts` returns `99`, `messages.load.ts` returns `0`). There is no test where the first script returns `0` and the second script returns non-zero (`99`).
- **Lines 93 & 101 (`BooleanLiteral`, `ConditionalExpression` — 4 Mutants)**:
  ```diff
  - await dependencies.resetRateLimits([]);
  - if (interrupted) {
  + if (false) {
      return SIGNAL_EXIT_CODE;
    }
  ```
  _Why they survived_: In the `SIGINT` test (`load.orchestrator.unit.test.ts`), `SIGINT` is fired inside `runK6`, so `if (interrupted)` on line 101 exits on the first script and line 93 is never reached; if line 101 is mutated to `if (false)`, the second script runs `runK6` which returns `130`, returning `130` via `codes.find(...)` without asserting that the second script's `runK6` was skipped.
- **Line 118 (`ConditionalExpression`, `EqualityOperator` — 2 Mutants)**:
  ```diff
  - if (k6Code === 0) {
  + if (true) {
      dependencies.log.info(`load: ${script} (${options.profile}) clean — removed ...`);
    }
  ```
  _Why they survived_: No test asserts that `log.info` is suppressed when `k6Code !== 0`.
- **Line 125 (`ConditionalExpression` — 1 Mutant)**:
  ```diff
  - if (cleanupFailed) {
  + if (false) {
  ```
  _Why it survived_: When `cleanup` throws after `k6Code === 99`, `k6Code !== 0 ? k6Code : 1` returns `99` anyway; and no test checks `cleanupFailed` when `runUserIds` throws after `k6Code === 0`.

#### 4. `scripts/load.ts` (37 Surviving / No-Coverage Mutants — 35.09%)

- **Lines 25–116 (35 No-Coverage Mutants)**: `main()`, `cleanupOnly()`, `preflight()`, `stopContainer()`, and `withTimeout()` have 0% unit test coverage.
- **Lines 84 & 90 (2 Surviving Mutants in `parseLoadArgs`)**:
  - `arg === '--'` -> `false` (no test passes `'--'` to `parseLoadArgs`).
  - `value.startsWith('--')` -> `false` (no test passes `['--profile', '--smoke']` where the next token starts with `'--'`).

#### 5. `test/load/support/fake-messages-server.ts` (21 Surviving Mutants in Sabotage Implementations)

- **Lines 99–121 (`MisorderedMessageRepository` — 15 Mutants)**: Mutating `this.mode === 'history-ascending'` to `true` or `false`, or mutating `input.before === null` in `'history-overlap'`, survives because `messages.load.sabotage.test.ts:138-153` only checks `toContain('history is newest first')` and `toContain('history pages are disjoint')` — and both modes fail the exact same 3 checks.
- **Lines 154–160 (`non-member-history` — 6 Mutants)**: Mutating `{ items: [], nextCursor: null }` to `{}` or mutating `status: 200` to `status: 201` survives because `non-member history is 403` fails on any status `!== 403`.
