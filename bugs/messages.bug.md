# Adversarial QA Vulnerability & Mutation Audit: Messaging Module (`messages`)

## Executive Summary

As Adversarial QA, a comprehensive black-box, gray-box, and white-box resilience and security evaluation was executed against the entire `messaging` module (`src/backend/messaging/`, `src/frontend/messaging/`, and `src/shared/contracts/messaging*.ts`). Testing combined mutation analysis via `@stryker-mutator/core` (invoked ephemerally via `bunx --bun @stryker-mutator/core` without modifying project dependencies or source files), boundary value analysis (BVA), equivalence partitioning, branch coverage sabotage, fault injection, and deterministic concurrency/race-condition probes against `bun test:unit`, `bun test:integration`, and `bun test:e2e`.

Despite 100% of existing repository tests passing (`424 pass` in `bun test:unit`, `25 pass` in `bun test:integration`, and `61 pass` in `bun test:e2e`), the test suite failed to detect **1,676 surviving Stryker mutants (59.52% overall mutation score across 4,140 mutants)** and allowed **12 confirmed bugs (4 Critical, 5 High, 3 Medium)**—including cross-room idempotency data leaks, unhandled PostgreSQL foreign-key crashes (HTTP 500), permanent E2EE cryptographic lockouts, and infinite WebSocket outbox livelocks—to slip through undetected.

---

## 1. Confirmed Bugs, Race Conditions & Attack Vectors

### BUG-CRITICAL-01: Cross-Room Idempotency Race Condition Leaks Room A's Message into Room B (`SendMessageUseCase` / `PostgresMessageRepository`)

- **Classification**: White-Box / Concurrency & Race Condition (TOCTOU) / Data Isolation Violation.
- **Target**:
  - [messaging.send-message.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.send-message.use-case.ts#L49-L67)
  - [messaging.messages.postgresql.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/infrastructure/messaging.messages.postgresql.ts#L43-L76)
- **How It Was Attacked**:
  A user belonging to two rooms (`roomA` and `roomB`) dispatched two concurrent `SendMessageUseCase.execute` calls with the same `idempotencyKey`—one targeting `roomA`, the other targeting `roomB`—synchronizing both calls right after `this.messages.findByIdempotencyKey(actor, idempotencyKey)` returned `null`.
- **What Failed & How It Failed**:
  1. Both concurrent requests executed `await this.messages.findByIdempotencyKey(actor, idempotencyKey)` (`messaging.send-message.use-case.ts:49`) before either `INSERT` committed, so both observed `existing === null` and bypassed the cross-room check `existing.roomId === room.value.id` (`line 51`).
  2. Both requests called `await this.messages.append(...)` (`line 59`).
  3. Request 1 (`roomA`) inserted the row first (`duplicate: false`).
  4. Request 2 (`roomB`) hit `ON CONFLICT (sender_id, idempotency_key) DO NOTHING` (`messaging.messages.postgresql.ts:50`), which returned no row.
  5. `PostgresMessageRepository.append` then executed `const original = await this.findByIdempotencyKey(message.senderId, message.idempotencyKey)` (`line 71`) and returned `{ duplicate: true, message: original }` **without verifying that `original.roomId === message.roomId`**.
  6. `SendMessageUseCase.execute` blindly returned `ok({ duplicate, message: message.toView() })` (`line 67`).
  7. **Observed Output**:
     ```text
     PROBE 1 outcome: {
       roomA: "01a1d6aa-f2bb-76c2-9cf7-5666450d979a",
       roomB: "01a1d6aa-f2c8-7af5-a392-b81030f07471",
       resA: { duplicate: false, returnedRoomId: "01a1d6aa-f2bb-76c2-9cf7-5666450d979a" },
       resB: { duplicate: true,  returnedRoomId: "01a1d6aa-f2bb-76c2-9cf7-5666450d979a" }
     }
     ```
     Request 2 (targeting `roomB`) succeeded with `ok: true` and returned the message from `roomA`!
  8. **Secondary Race in the Same Window (Stale `keyEpoch` Bypass)**:
     Because `room.value.assertCurrentEpoch(keyEpoch)` (`line 55`) runs in memory before `this.messages.append(...)` and `sql/index.sql` has no trigger verifying `NEW.key_epoch = rooms.key_epoch` on `INSERT INTO messages`, a concurrent member join/leave that bumps `rooms.key_epoch` after `roomOfMember` allows `append` to persist a message encrypted under a stale `key_epoch`.
- **Why Current Test Suite Missed It**:
  - `messaging.use-cases.test.ts` and `messaging.repositories.integration.test.ts` only test idempotency retries sequentially.
  - `InMemoryMessageRepository.append` (`messaging.fakes.test-support.ts:75`) also omits checking `existing.roomId === draft.roomId`.
- **Expected Behavior**:
  `SendMessageUseCase.execute` (or `PostgresMessageRepository.append`) must verify `message.roomId === room.value.id` when `duplicate === true` and return `err(new ConflictError('idempotencyKey was already used for another message'))`. Additionally, the database trigger `messages_assert_sender_is_member` should enforce `NEW.key_epoch = rooms.key_epoch`.

---

### BUG-CRITICAL-02: Unhandled Foreign-Key Exception (`SQLSTATE 23503` -> HTTP 500) & Stale Epoch Storage in `StoreSenderKeysUseCase` / `PostgresSenderKeyRepository`

- **Classification**: White-Box / Concurrency & Fault Injection / Broken `Result` Contract.
- **Target**:
  - [messaging.keys.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.keys.use-case.ts#L110-L128)
  - [messaging.keys.postgresql.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/infrastructure/messaging.keys.postgresql.ts#L73-L94)
- **How It Was Attacked**:
  Initiated `StoreSenderKeysUseCase.execute` for a 3-member room (`users[0], users[1], users[2]`), and concurrently removed `users[2]` (`rooms.removeMember`) right after `roomOfMember` and `envelopeOf` validated membership in memory, before `this.senderKeys.store(valid)` executed `INSERT INTO sender_key_envelopes`.
- **What Failed & How It Failed**:
  1. `StoreSenderKeysUseCase.execute` checked `room.isMember(recipientId)` (`messaging.keys.use-case.ts:170`) and `room.value.assertCurrentEpoch(keyEpoch)` (`line 114`) against an in-memory snapshot outside a database transaction.
  2. When `users[2]` left the room concurrently, `rooms.key_epoch` incremented from `2` to `3` and `(room_id, users[2])` was deleted from `room_members`.
  3. `PostgresSenderKeyRepository.store` executed `INSERT INTO sender_key_envelopes ...` (`messaging.keys.postgresql.ts:88`) with **zero error mapping**.
  4. PostgreSQL threw `PostgresError` with `errno: "23503"` (`violates foreign key constraint "sender_key_envelopes_room_id_recipient_id_fkey"`).
  5. **Observed Output**:
     ```text
     PostgresError: insert or update on table "sender_key_envelopes" violates foreign key constraint "sender_key_envelopes_room_id_recipient_id_fkey"
       errno: "23503",
       detail: "Key (room_id, recipient_id)=(01a1d6aa-f2de-772b-b89c-d4a303d5a9e3, 3) is not present in table \"room_members\"."
     ```
  6. Because neither `PostgresSenderKeyRepository.store` nor `StoreSenderKeysUseCase.execute` catches `23503`, the promise **rejected with an uncaught database exception** instead of returning a `Result`, causing the REST endpoint `POST /api/rooms/:roomId/sender-keys` to respond with `500 Internal Server Error`.
  7. Even worse, if a member **joins** concurrently (bumping `rooms.key_epoch` from `2` to `3` without deleting existing `room_members`), `INSERT INTO sender_key_envelopes` succeeds for the stale `key_epoch = 2` and `messaging.controller.ts:161` broadcasts `sender-keys.available` for stale epoch `2`!
- **Why Current Test Suite Missed It**:
  - `test/e2e/messaging.e2e.test.ts` never calls `/api/rooms/:roomId/sender-keys` at all.
  - `test/integration/messaging.repositories.integration.test.ts` only tests sequential `senderKeys.store` calls.
- **Expected Behavior**:
  Wrap `senderKeys.store` in a transaction or database guard that verifies `rooms.key_epoch` and maps `SQLSTATE 23503` on `sender_key_envelopes_room_id_sender_id_fkey` (`ForbiddenError`) and `sender_key_envelopes_room_id_recipient_id_fkey` (`ConflictError` / `ValidationError`), returning `Result.err(...)` instead of throwing an unhandled 500 error.

---

### BUG-CRITICAL-03: Unhandled Generic `Error` in `ReceiptUseCase` & `PostgresReceiptRepository.advance` Crashes into `500 internal` on Concurrent Room Leave

- **Classification**: White-Box / Concurrency & Race Condition / Error Contract Violation.
- **Target**:
  - [messaging.receipt.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.receipt.use-case.ts#L42-L57)
  - [messaging.receipts.postgresql.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/infrastructure/messaging.receipts.postgresql.ts#L24-L43)
- **How It Was Attacked**:
  Dispatched a `receipt` frame (`ReceiptUseCase.execute`) for `users[2]` while concurrently removing `users[2]` from the room after `roomOfMember` (`line 42`) and `messages.exists` (`line 47`) resolved, right before `this.receipts.advance(...)` (`line 50`). Also mutated `if (!row)` in `messaging.receipts.postgresql.ts:41` with Stryker.
- **What Failed & How It Failed**:
  1. `UPDATE room_members ... WHERE room_id = $1 AND user_id = $2 RETURNING ...` returned `0` rows (`row === undefined`).
  2. `PostgresReceiptRepository.advance` executed line 40:
     ```ts
     if (!row) {
       throw new Error(`user ${userId} is not a member of room ${roomId}`);
     }
     ```
  3. Because it throws a raw `Error` (not a `ForbiddenError` subclass of `AppError`), `ReceiptUseCase.execute` rejected its promise instead of returning `Result.err(new ForbiddenError(...))`, and `Gateway.fail` (`messaging.socket.gateway.ts:287-293`) treated it as an unexpected server crash (`code: 'internal'`, `logger.error(error)`).
  4. Furthermore, Stryker's mutations on `messaging.receipts.postgresql.ts:41`:
     ```diff
     - if (!row) {
     -   throw new Error(`user ${userId} is not a member of room ${roomId}`);
     - }
     + if (false) {}
     ```
     **survived 100% of unit, integration, and e2e tests** because no test ever exercises `advance` when `row` is missing!
- **Why Current Test Suite Missed It**:
  - `InMemoryReceiptRepository.advance` (`messaging.fakes.test-support.ts:116`) does not check membership at all—it blindly creates a watermark in memory even if the user left the room.
  - `test/integration/messaging.repositories.integration.test.ts` only tests `receipts.advance` on an active member.
- **Expected Behavior**:
  `PostgresReceiptRepository.advance` (and `InMemoryReceiptRepository.advance`) should throw `ForbiddenError('You are not a member of this room')` when no `room_members` row matches, and `ReceiptUseCase.execute` should catch `ForbiddenError` and return `err(error)`.

---

### BUG-CRITICAL-04: Permanent E2EE Cryptographic Lockout When a Member Publishes Their Identity Key After Epoch Preparation (`EpochKeeper` & `SenderKeySession`)

- **Classification**: Gray-Box / Cryptographic Protocol Defect / State Machine Deadlock.
- **Target**:
  - [chat.epochs.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.epochs.ts#L141-L171)
  - [messaging.crypto.session.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/crypto/messaging.crypto.session.ts#L132-L163)
  - [messaging.crypto.primitives.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/crypto/messaging.crypto.primitives.ts#L78-L85)
- **How It Was Attacked**:
  Simulated a normal two-user onboarding flow:
  1. Alice signs up, opens `/chat` (publishing her X25519 identity key), and creates a room with Bob (who signed up via `/sign-up` and has not opened `/chat` yet, or whose identity key publish is still in flight).
  2. Alice prepares `keyEpoch = 2` via `EpochKeeper.ensureEpoch('room-1', 2)` and sends `"Hello Bob!"`.
  3. Bob then opens `/chat`, publishes his identity key (`PUT /api/keys/identity`), and attempts to decrypt Alice's message (even after Alice reloads `/chat` and runs `ensureEpoch('room-1', 2)` again).
- **What Failed & How It Failed**:
  1. During step 2, `GET /api/rooms/:roomId/keys` (`ListRoomKeysUseCase`, `messaging.keys.use-case.ts:68`) only returned `[Alice]`, because `user_identity_keys` had no entry for Bob yet.
  2. `SenderKeySession.prepareEpoch` generated Alice's AES-256-GCM chain key for `room-1` epoch `2`, stored it in `KeyStore` (`saveChainKey`), wrapped an envelope **only for Alice (`recipientId: 1`)**, and zeroed the raw key bytes (`chain.raw.fill(0)`, `messaging.crypto.session.ts:159`).
  3. `EpochKeeper.ensureEpoch` uploaded `[Alice's envelope]` (`201 Created`) and marked `room-1:2` as prepared in `#prepared`.
  4. When Bob opened `/chat` and published his identity key:
     - Backend `PublishIdentityKeyUseCase` emits **no WebSocket event** to notify room peers that Bob now has an identity key.
     - Even when Alice reloads the browser (`keeper.forget('room-1', 2)`) and calls `keeper.ensureEpoch('room-1', 2)` again with `roomKeys` now containing `[Alice, Bob]`, `SenderKeySession.prepareEpoch` executes lines 145–147:
       ```ts
       const existing = await this.store.getChainKey(id);
       if (existing !== null) {
         return [];
       }
       ```
       It immediately returns `[]`!
     - Worse: because `importChainKey` imports the AES-GCM key with `extractable: false` (`messaging.crypto.primitives.ts:83`) and `chain.raw` was zeroed, Alice's browser **cannot extract her own chain key** to wrap an envelope for Bob!
  5. **Observed Output**:
     ```text
     PROBE 5 uploaded envelopes after Bob published key and Alice reloaded: [ 1 ]
     PROBE 5 Bob decrypt result: null
     ```
     Bob is **permanently locked out** of decrypting any message sent by Alice in that room until a membership change forces a new `keyEpoch`!
- **Why Current Test Suite Missed It**:
  - Every test in `chat.epochs.test.ts` and `messaging.crypto.session.test.ts` pre-populates identity keys for all members before calling `ensureEpoch`.
  - `test/e2e/messaging.e2e.test.ts` never exercises `EpochKeeper`, `SenderKeySession`, or `/api/keys/identity`.
- **Expected Behavior**:
  Either require all room members to have published identity keys before `ensureEpoch` marks the epoch prepared for all members, or retain wrap capability / rotate the sender's chain key when a member without an envelope publishes their identity key.

---

### BUG-HIGH-05: Infinite Outbox Livelock on Stale Epoch after Reconnect & Multi-Tab `ChainIndex` Exhaustion (`OutboxFlusher` & `ChatController`)

- **Classification**: Gray-Box / Concurrency & State Synchronization / Infinite Retry Loop.
- **Target**:
  - [messaging.outbox-flusher.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/connection/messaging.outbox-flusher.ts#L137-L165)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L105)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L454-L480)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L528-L555)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L643-L653)
- **How It Was Attacked**:
  - **Attack A (Multi-Tab `ChainIndex` Lag >= 2)**: Opened two logical tabs for the same user. Tab 1 sent two messages (`chainIndex: 0` and `chainIndex: 1`). Tab 2 (whose local `chainIndex` counter started at `0`) enqueued a message and flushed `OutboxFlusher`.
  - **Attack B (Reconnect After Missed `room.rotated`)**: Disconnected a client that already had `room-1` (`keyEpoch: 2`) in `ChatController.#rooms`, rotated the room on the server to `keyEpoch: 3`, reconnected the socket (receiving `ready` with `roomIds: ['room-1']`), and flushed a queued message.
- **What Failed & How It Failed**:
  1. **In Attack A**:
     - Tab 2 encrypted its message with `chainIndex: 0`. The server returned `{ type: 'error', code: 'conflict', message: 'chainIndex was already used in this key epoch; encrypt again' }`.
     - `OutboxFlusher.#deliver` (`messaging.outbox-flusher.ts:160`) retried **only once** (`if (reply.code === 'conflict' && !retried)`), encrypting with `chainIndex: 1` (also already used by Tab 1!).
     - The server returned `conflict` again, and `OutboxFlusher` halted with:
       ```json
       {
         "error": {
           "code": "conflict",
           "message": "chainIndex was already used in this key epoch; encrypt again"
         },
         "idempotencyKey": "key-1",
         "reason": "rejected"
       }
       ```
  2. **In Attack B (Infinite Livelock)**:
     - Upon reconnect, `ChatController.#onReady(roomIds)` (`chat.controller.ts:644`) checked:
       ```ts
       if (roomIds.some((roomId) => !this.#rooms.has(roomId))) {
         await this.#reloadRooms();
       }
       ```
       Because `this.#rooms.has('room-1')` was already `true`, `#onReady` **skipped `#reloadRooms()`**, leaving `this.#rooms.get('room-1').keyEpoch` stuck at stale `2`!
     - When `OutboxFlusher` sent the message with `keyEpoch: 2`, the server returned `code: 'conflict'` (`Sender key epoch is stale; rotate to epoch 3`).
     - `OutboxFlusher` retried once by calling `ChatController.#encrypt(item)` (`chat.controller.ts:454`), which read the **exact same stale `room.keyEpoch` (`2`)** from `this.#rooms.get(item.roomId)` without refreshing the room from the server!
     - The retry failed with `conflict` again, triggering `#onFlushStop(stop)` (`chat.controller.ts:528`).
     - Because `PERMANENT_ERRORS = new Set(['bad_frame', 'forbidden', 'not_found', 'validation'])` (`line 105`) does **not** include `'conflict'`, `#onFlushStop` scheduled `#scheduleFlushRetry()` (`line 539`), which re-triggers `this.#flusher.onReady()` every `5,000 ms` **forever**—never reloading the room's `keyEpoch`, burning two `chainIndex` values every 5 seconds, and head-of-line blocking the entire outbox for all rooms!
- **Why Current Test Suite Missed It**:
  - `messaging.outbox-flusher.test.ts` only tests a single `conflict` where the second attempt immediately succeeds.
  - `chat.controller.test.ts` never tests `conflict` handling, multi-tab `chainIndex` drift, or epoch rotation while offline (`593` surviving mutants in `src/frontend/messaging/application/`, `28.92%` score on `chat.controller.ts`).
- **Expected Behavior**:
  `ChatController.#onReady` must always reload rooms (`await this.#reloadRooms()`) so `keyEpoch` and `memberIds` are fresh after a reconnect; on a `conflict` stop (or before a `conflict` retry), `ChatController` must reload the room's current `keyEpoch` from `GET /api/rooms`, and if `idempotencyKey was already used for another message` occurs, treat it as a permanent rejection instead of livelocking the outbox.

---

### BUG-HIGH-06: Boundary Value & Validation Defects in `HistoryUseCase` (`since = 0` Excludes Millisecond 0, Pre-1970 Clamping, Inverted Window `since > until`, and Surviving Pagination Mutants)

- **Classification**: Black-Box & Gray-Box / Boundary Value Analysis (BVA) / Stryker Mutant Survival.
- **Target**:
  - [messaging.history.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.history.use-case.ts#L43-L95)
  - [messaging.value-objects.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/domain/messaging.value-objects.ts#L216-L220)
- **How It Was Attacked**:
  Probed `HistoryUseCase` and `uuidV7Bound` at timestamp boundaries (`since = "1970-01-01T00:00:00.000Z"`, pre-1970 dates `"1960-01-01T00:00:00.000Z"`, inverted ranges `since > until`, and page size boundaries `limit = "1"`, `limit = "100"`, `rows.length === limit`), alongside Stryker mutation testing.
- **What Failed & How It Failed**:
  1. **Inclusive `since` Broken at Epoch `0` (`1970-01-01T00:00:00.000Z`)**:
     `HistoryUseCase` documents `since` as inclusive (`line 19`) and computes the exclusive lower bound `after` as `uuidV7Bound(since - 1, 'max')` (`line 74`).
     When `since === 0`, `since - 1` is `-1`. Inside `uuidV7Bound(-1, 'max')` (`messaging.value-objects.ts:217`):
     `Math.max(0, Math.trunc(-1))` clamps `-1` back to `0` with the `'max'` tail (`00000000-0000-7fff-bfff-ffffffffffff`)!
     ```text
     PROBE 4A since=0: {
       after: "00000000-0000-7fff-bfff-ffffffffffff",
       minUuidAtZero: "00000000-0000-7000-8000-000000000000",
       minIsGreaterThanAfter: false
     }
     ```
     Every UUIDv7 generated at millisecond `0` is `<= after`, so `id > after` **excludes millisecond `0` instead of including it**.
  2. **Pre-1970 Dates Silently Clamped to `1970-01-01` & Inverted `since > until` Accepted**:
     Passing `until: "1960-01-01T00:00:00.000Z"` parses to a negative timestamp (`-315619200000`), which `uuidV7Bound` silently clamps to `0` (`1970-01-01T00:00:00.000Z`). Passing `since: "2026-11-12T10:00:00.000Z"` and `until: "1960-01-01T00:00:00.000Z"` (`since > until`) returns `ok({ messages: [], nextBefore: null })` instead of a validation error.
  3. **32 Surviving Stryker Mutants in `messaging.history.use-case.ts` (`69.81%` Mutation Score)**:
     - **Pagination Boundary (`line 49`)**:
       ```diff
       - nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
       + nextBefore: rows.length >= limit ? (page.at(-1)?.id ?? null) : null,
       + nextBefore: rows.length > limit ? (page.at(+1)?.id ?? null) : null,
       ```
       Both mutants survived! When `rows.length === limit` (exact last page), mutating `>` to `>=` returns a non-null `nextBefore` cursor pointing to the last item even though no older messages exist; and mutating `page.at(-1)` to `page.at(+1)` returns the **second** message's ID instead of the last message's ID as `nextBefore`, skipping messages on the next page! Why did `page.at(+1)` survive? Because the only pagination test in `messaging.use-cases.test.ts` uses `limit: '2'`, where `page` has length `2`, so `page.at(-1)` (`page[1]`) and `page.at(+1)` (`page[1]`) are the **exact same element**!
     - **`limit` Boundaries (`line 87`)**:
       ```diff
       - if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
       + if (!Number.isInteger(value) || value <= 1 || value > MAX_PAGE_SIZE) {
       + if (!Number.isInteger(value) || value < 1 || value >= MAX_PAGE_SIZE) {
       ```
       Both `limit = "1"` and `limit = "100"` (`MAX_PAGE_SIZE`) boundaries are completely untested!
- **Expected Behavior**:
  Reject timestamps `< 0` and `since >= until` in `historyQueryOf`; add unit tests for `limit = "1"`, `limit = "100"`, `rows.length === limit`, and `limit >= 3` (where `page.at(-1) !== page.at(+1)`).

---

### BUG-HIGH-07: WebSocket Presence Desynchronization on Concurrent Socket Opens & Room Membership Changes (`Gateway`)

- **Classification**: White-Box / Concurrency & Real-Time Protocol Defect / Stryker Mutant Survival.
- **Target**:
  - [messaging.socket.gateway.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.gateway.ts#L81-L90)
  - [messaging.socket.gateway.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.gateway.ts#L144-L156)
  - [messaging.socket.gateway.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.gateway.ts#L312-L318)
  - [messaging.socket.gateway.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.gateway.ts#L440-L470)
- **How It Was Attacked**:
  - **Attack A (Concurrent Dual-Socket Open + Early Close)**: User 1 opened two WebSocket connections (`ws1`, `ws2`) concurrently. `ws1` closed while `listRooms.execute` was still resolving.
  - **Attack B (Member Added via REST)**: User 3 (already connected on `/ws`) was added to a room via `POST /api/rooms/:roomId/members` (`events.membersChanged`).
  - **Attack C (Stryker Mutation on `presenceSnapshot`, `line 316`)**: Mutated `online: memberIds.filter((id) => this.byUser.has(id))` to `online: memberIds`.
- **What Failed & How It Failed**:
  1. **In Attack A**:
     In `Gateway.open(ws)` (`line 147`), `const firstSocket = sockets.size === 0` is computed synchronously before `this.welcome(ws, firstSocket)` awaits `this.deps.listRooms.execute(connection.userId)` (`line 442`).
     - `ws1` gets `firstSocket = true`; `ws2` gets `firstSocket = false`.
     - When `ws1` closes before `listRooms.execute` finishes, `ws1` exits at `if (connection.isReleased) return;` (`line 447`) without publishing `online: true`.
     - `ws2` finishes `welcome()`, but because its `announce` parameter was `false`, it **never** publishes `{ type: 'presence', online: true, userId: 1 }` (`line 460`)!
     - **Observed Output**: `PROBE 7A User 1 active connections: 1, presence online frames published: []`. User 1 is online and connected, but every room member sees User 1 as offline!
  2. **In Attack B**:
     When User 3 is added to a room, `Gateway.events.membersChanged` (`line 82-90`) subscribes User 3's socket to `room:<id>` and broadcasts `room.rotated`, but **never** sends `presence.snapshot` to User 3's socket and **never** broadcasts User 3's `presence` to the room (`PROBE 7B frames sent directly to added member ws3 on membersChanged: []`).
  3. **In Attack C (Stryker Mutant Survived)**:
     ```diff
     - online: memberIds.filter((id) => this.byUser.has(id)),
     + online: memberIds,
     ```
     Removing `.filter((id) => this.byUser.has(id))` so `presence.snapshot` reports **every offline member as online** survived 100% of unit, integration, and e2e tests! Why? Because in `messaging.socket.gateway.test.ts`, the only test checking `presence.snapshot` connects all members before inspecting `online`.
- **Why Current Test Suite Missed It**:
  - No test in `messaging.socket.gateway.test.ts` checks `presence.snapshot` when a room member is offline, nor tests concurrent socket opens where the first socket closes during `welcome`, nor checks presence after `events.membersChanged`.
- **Expected Behavior**:
  Track whether presence was actually announced per user (or announce from the first socket that completes `welcome`), send `presence.snapshot` / `presence` on `events.membersChanged`, and test `presence.snapshot` with offline members.

---

### BUG-HIGH-08: Unanchored Regexes, `MAX_INT32` Overflow Bypass, and Non-Strict Base64 Mutants Survive in `messaging.value-objects.ts`

- **Classification**: Black-Box & White-Box / Boundary Value Analysis / Stryker Mutant Survival.
- **Target**: [messaging.value-objects.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/domain/messaging.value-objects.ts#L24-L210)
- **How It Was Attacked**:
  Executed Stryker mutation testing across `src/backend/messaging/domain/messaging.value-objects.ts` (`24` mutants survived).
- **What Failed & How It Failed**:
  1. **Unanchored UUID Regex Mutants Survived (`lines 24-25`)**:
     ```diff
     - const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
     + const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
     + const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u;
     - const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
     + const UUID_V7_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
     + const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u;
     ```
     All 4 regex anchor removals survived because `messaging.value-objects.test.ts` never tests a valid UUID with leading or trailing characters (e.g. `"prefix-" + V7` or `V7 + "-suffix"`).
  2. **Non-Canonical Base64 Malleability (`line 33`)**:
     ```diff
     - return Uint8Array.fromBase64(raw, { lastChunkHandling: 'strict' });
     + return Uint8Array.fromBase64(raw, {});
     ```
     Survived because no test supplies base64 with non-zero padding bits or missing `=` padding.
  3. **`MemberId.create` `MAX_INT32` Upper Boundary Untested (`line 205`)**:
     ```diff
     - if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_INT32) {
     + if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || false) {
     + if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw >= MAX_INT32) {
     ```
     Both mutants survived! Without `raw > MAX_INT32`, passing `userId: 2_147_483_648` bypasses domain validation and triggers an unhandled PostgreSQL `22003` (`value "2147483648" is out of range for type integer`) 500 error!
  4. **`KeyEpoch` / `ChainIndex` Error Payload Untested (`line 54`)**:
     ```diff
     - return err({ field, message: `${field} must be an integer from 0 to ${MAX_INT32}` });
     + return err({});
     ```
     Survived because `messaging.value-objects.test.ts:70-73` only asserts `.ok === false` without checking `.error`.
- **Expected Behavior**:
  Add unit tests covering UUID prefix/suffix rejections, non-canonical base64 chunks, `MemberId.create(2_147_483_647)` (accepted) vs `MemberId.create(2_147_483_648)` (rejected), and exact error objects for `KeyEpoch` and `ChainIndex`.

---

### BUG-HIGH-09: Coupled Multi-Field Validation Blind Spots Across All Application Use Cases (`||` -> `&&` Mutants Survive)

- **Classification**: Gray-Box / Branch Coverage / Stryker Mutant Survival.
- **Target**:
  - [messaging.send-message.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.send-message.use-case.ts#L36-L43)
  - [messaging.rooms.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.rooms.use-case.ts#L19-L25)
  - [messaging.rooms.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.rooms.use-case.ts#L43-L45)
  - [messaging.keys.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.keys.use-case.ts#L43-L52)
  - [messaging.keys.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.keys.use-case.ts#L101-L109)
  - [messaging.keys.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.keys.use-case.ts#L160-L176)
  - [messaging.history.use-case.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.history.use-case.ts#L61-L69)
  - [messaging.access.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/application/messaging.access.ts#L59-L63)
- **How It Was Attacked**:
  Stryker replaced logical `||` with `&&` and replaced individual guard conditions with `false` across all application use cases.
- **What Failed & How It Failed**:
  1. **`SendMessageUseCase.execute` (`messaging.send-message.use-case.ts:36-43`)**:
     ```diff
     - if (idempotencyKey === undefined || keyEpoch === undefined || chainIndex === undefined || payload === undefined)
     + if ((idempotencyKey === undefined || keyEpoch === undefined || chainIndex === undefined) && payload === undefined)
     + if (false || false || false || payload === undefined)
     ```
     All 9 mutants on this guard survived! Why? Because `messaging.use-cases.test.ts:154-166` only tests invalid `SendMessageUseCase` input when **all 4 parts (`idempotencyKey`, `keyEpoch`, `chainIndex`, and `payload`) are invalid at the same time**! If a client sends an invalid `idempotencyKey` (or negative `keyEpoch` or negative `chainIndex`) with a valid `payload`, the mutated guard does not return `err(fields.error())`!
  2. **`CreateRoomUseCase.execute` (`messaging.rooms.use-case.ts:43-45`)**:
     ```diff
     - if (name === undefined || memberIds === undefined)
     + if (name === undefined && memberIds === undefined)
     ```
     Survived because `messaging.use-cases.test.ts` never tests `(invalid name, valid memberIds)` or `(valid name, invalid memberIds)` in isolation!
  3. **`AddMemberUseCase.execute` (`messaging.rooms.use-case.ts:20-23`)**:
     ```diff
     - if (!userId.ok) {
     -   return err(new ValidationError([userId.error]));
     - }
     + if (false) {}
     ```
     Survived because **no test in the entire repository ever passes an invalid `userId` (e.g. `0`, `-1`, `"abc"`) to `AddMemberUseCase`**!
  4. **`FetchSenderKeysUseCase.execute` (`messaging.keys.use-case.ts:43-50`)**:
     ```diff
     - if (epoch !== null && !epoch.ok) {
     -   return err(new ValidationError([epoch.error]));
     - }
     + if (false) {}
     - const keyEpoch = epoch === null ? room.value.keyEpoch : epoch.value;
     + const keyEpoch = true ? room.value.keyEpoch : epoch.value;
     ```
     Both survived! No test ever passes an explicit `?keyEpoch=...` query parameter (valid or invalid) to `FetchSenderKeysUseCase`! If a client requests historical sender keys for `keyEpoch=2` after a room rotated to `keyEpoch=3`, the mutated code ignores the query parameter and always returns epoch `3`!
  5. **`roomOfMember` (`messaging.access.ts:59-61`)**:
     ```diff
     - if (!roomId.ok) {
     -   return err(new ValidationError([roomId.error]));
     - }
     + if (false) {}
     ```
     Survived in unit tests because `InMemoryRoomRepository.findById` returns `null` for an invalid `roomId`, which `roomOfMember` turns into `ForbiddenError` (403) instead of `ValidationError` (400), and no unit test asserts that an invalid `roomId` format returns `400 ValidationError`!
- **Expected Behavior**:
  Test single-field validation failures independently in every use case, test `AddMemberUseCase` with invalid `userId`, test `FetchSenderKeysUseCase` with explicit valid and invalid `keyEpoch` query values, and assert `400 ValidationError` for malformed `roomId`.

---

### BUG-MEDIUM-10: Unhandled Database Error Masking in `PostgresRoomRepository.guarded` & `PostgresMessageRepository.append`

- **Classification**: White-Box / Fault Injection / Stryker Mutant Survival.
- **Target**:
  - [messaging.rooms.postgresql.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/infrastructure/messaging.rooms.postgresql.ts#L91-L114)
  - [messaging.messages.postgresql.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/infrastructure/messaging.messages.postgresql.ts#L56-L70)
- **How It Was Attacked**:
  Stryker mutated the `catch (error)` clauses in `PostgresRoomRepository.guarded` and `PostgresMessageRepository.append` across `test:integration` and `test:e2e`.
- **What Failed & How It Failed**:
  1. In `PostgresRoomRepository.guarded` (`messaging.rooms.postgresql.ts:95-110`):
     ```diff
     - if (error instanceof SQL.PostgresError) {
     + if (true) {
     ...
     -   if (error.errno === FOREIGN_KEY_VIOLATION) {
     +   if (true) {
           throw new ValidationError([{ field: 'memberIds', message: 'Every member must be an existing user' }]);
         }
     ```
     **7 mutants survived** on the error-mapping conditionals in `guarded()`! If PostgreSQL drops the connection, runs out of connections, hits a deadlock (`40P01`), or encounters a disk error during `rooms.create`, `rooms.addMember`, or `rooms.removeMember`, the mutated catch block masks the 500 database failure as a `400 ValidationError` (`Every member must be an existing user`) or `409 ConflictError`!
  2. In `PostgresMessageRepository.append` (`messaging.messages.postgresql.ts:62-66`):
     ```diff
     - if (error instanceof SQL.PostgresError && error.errno === UNIQUE_VIOLATION && error.constraint === 'messages_chain_uq')
     + if (true && error.constraint === 'messages_chain_uq')
     ```
     Survived because no fault-injection test verifies that unexpected database errors in `PostgresRoomRepository` or `PostgresMessageRepository` bubble up untouched.
- **Expected Behavior**:
  Add fault-injection integration tests (similar to `user.datasource.fault-injection.integration.test.ts`) verifying that non-mapped `SQL.PostgresError` codes and generic errors rethrow as 500 errors.

---

### BUG-MEDIUM-11: Memory & State Leaks in `Gateway.track` (`inFlight` Set Leak) and `ChatController.leaveRoom` (Orphaned Outbox & Plaintext Cache)

- **Classification**: White-Box / Resource & Memory Leak / State Cleanup Defect.
- **Target**:
  - [messaging.socket.gateway.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.gateway.ts#L398-L408)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L263-L284)
  - [chat.controller.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.controller.ts#L528-L555)
- **How It Was Attacked**:
  1. In `Gateway.track` (`messaging.socket.gateway.ts:407`), Stryker mutated:
     ```diff
     - void settled.finally(() => this.inFlight.delete(settled));
     + void settled.finally(() => undefined);
     ```
     This mutant **survived all tests**: `this.inFlight` retains every settled WebSocket frame promise in memory for the lifetime of the server, leaking memory proportional to total frames processed!
  2. In `Gateway.release` (`messaging.socket.gateway.ts:213-215`), Stryker mutated:
     ```diff
     - if (this.connections.size === 0) {
     -   this.stopHeartbeat?.();
     -   this.stopHeartbeat = null;
     - }
     + if (false) {}
     ```
     This mutant **survived all tests**: the heartbeat `setInterval` timer is never stopped when all clients disconnect!
  3. In `ChatController.leaveRoom()` (`chat.controller.ts:263-284`):
     When a user leaves a room, `leaveRoom()` deletes `#rooms`, `#entries`, `#cursors`, and `#historyRequested`, and calls `#keeper.forgetRoom(roomId)`, but **fails to clean up**:
     - Queued items for `roomId` in `this.#deps.outbox` and `this.#queuedRooms`: when the outbox flushes next, `#encrypt` throws `Unknown room ${item.roomId}`, and `#onFlushStop` displays a spurious error notification `"A message was not sent: The room is no longer available."` after the user already intentionally left the room!
     - `this.#localTexts.delete(roomId)` (retains decrypted plaintext messages in memory after leaving the room).
     - `this.#online.delete(roomId)` and `this.#undecrypted` entries for `roomId`.
- **Expected Behavior**:
  Assert in unit tests that `inFlight` and heartbeat timers are cleaned up when frames settle and sockets close; in `ChatController.leaveRoom`, purge queued outbox entries, `#localTexts`, `#online`, and `#undecrypted` for the departed room.

---

### BUG-MEDIUM-12: Unverified Frontend Runtime Adapters (`0.00%` Mutation Score on 4 Files) & Loose API Type Guards (`chat.api.guards.ts`)

- **Classification**: Gray-Box & White-Box / Test Gap & Contract Validation Weakness.
- **Target**:
  - [chat.api.guards.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/application/chat.api.guards.ts#L22-L107)
  - [chat.page.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/chat.page.ts#L1-L429)
  - [messaging.outbox.indexed-db.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/connection/messaging.outbox.indexed-db.ts#L1-L104)
  - [messaging.browser.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/frontend/messaging/connection/messaging.browser.ts#L1-L57)
  - [messaging.socket.scheduler.ts](file:///home/sergioa/soft-dev/personal-projects/chat-rsa/src/backend/messaging/presentation/messaging.socket.scheduler.ts#L1-L26)
- **How It Was Attacked**:
  Ran Stryker across all frontend and backend adapters and inspected `chat.api.guards.ts`.
- **What Failed & How It Failed**:
  1. **`chat.api.guards.ts` (`43.66%` Mutation Score — 80 of 142 Mutants Survived)**:
     - Mutating `arrayOf` (`line 23`) from `value.every((item) => guard(item))` to `value.some((item) => guard(item))` survived! If the server returns `[validRoom, corruptedRoom]`, `arrayOf` accepts the corrupted array as long as 1 element is valid.
     - Mutating the entire body of `isAuthPayload`, `isHistoryPage`, `isIdentityKeyView`, `isMessageView`, `isPublicUser`, `isReceiptWatermark`, `isRoomSummary`, `isSenderKeyEnvelopeView`, and `isStoredSenderKeys` to `return true;` **all survived**!
  2. **Complete `0.00%` Mutation Score on 4 Production Files (483 Mutants Survived Unchallenged)**:
     - `src/frontend/messaging/chat.page.ts`: **0.00%** (0 / 352 mutants killed).
     - `src/frontend/messaging/connection/messaging.outbox.indexed-db.ts`: **0.00%** (0 / 86 mutants killed).
     - `src/frontend/messaging/connection/messaging.browser.ts`: **0.00%** (0 / 36 mutants killed).
     - `src/backend/messaging/presentation/messaging.socket.scheduler.ts`: **0.00%** (0 / 9 mutants killed — including mutating `Math.min(Math.max(0, ms), MAX_DELAY_MS)` to `Math.max(...)`, which breaks 32-bit timer clamping).
     - `src/frontend/messaging/crypto/messaging.crypto.key-store.ts`: **16.67%** (70 / 84 mutants survived; `IndexedDbKeyStore` is 0% tested).
     - `src/frontend/messaging/search/messaging.search.ts`: **38.52%** (83 / 135 mutants survived; `IndexedDbLocalMessageStore` is 0% tested).
- **Expected Behavior**:
  Add negative unit tests for each type guard in `chat.api.guards.ts` (including arrays with one valid and one invalid item), unit-test `systemScheduler` timer clamping/cancellation, and test IndexedDB/DOM adapters with a lightweight fake or headless harness.

---

## 2. Stryker Mutation Testing Summary

Commands executed (without modifying `package.json` or installing dependencies into the project):

1. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test:unit" --coverageAnalysis off --mutate "src/backend/messaging/domain/**/*.ts,!src/backend/messaging/domain/**/*.test.ts" --reporters clear-text`
2. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test:unit" --coverageAnalysis off --mutate "src/backend/messaging/application/**/*.ts,!src/backend/messaging/application/**/*.test.ts,!src/backend/messaging/application/**/messaging.fakes.test-support.ts" --reporters clear-text`
3. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test ./test/integration/messaging.repositories.integration.test.ts ./test/integration/messages.schema.integration.test.ts ./test/e2e/messaging.e2e.test.ts" --coverageAnalysis off --mutate "src/backend/messaging/infrastructure/**/*.ts" --reporters clear-text`
4. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test:unit" --coverageAnalysis off --mutate "src/backend/messaging/presentation/**/*.ts,!src/backend/messaging/presentation/**/*.test.ts,!src/backend/messaging/presentation/**/messaging.socket.fakes.test-support.ts" --reporters clear-text`
5. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test ./src/frontend/messaging" --coverageAnalysis off --mutate "src/frontend/messaging/crypto/**/*.ts,src/frontend/messaging/connection/**/*.ts,src/frontend/messaging/search/**/*.ts,src/frontend/messaging/presentation/**/*.ts,!src/frontend/messaging/**/*.test.ts,!src/frontend/messaging/**/*.test-support.ts" --reporters clear-text`
6. `bunx --bun @stryker-mutator/core run --inPlace --cleanTempDir always --testRunner command --commandRunner.command "bun test ./src/frontend/messaging" --coverageAnalysis off --mutate "src/frontend/messaging/application/**/*.ts,src/frontend/messaging/chat.page.ts,!src/frontend/messaging/**/*.test.ts" --reporters clear-text`

| Layer / File                                                         | Mutation Score | Total Mutants | Killed    | Timeout | Survived  |
| :------------------------------------------------------------------- | :------------- | :------------ | :-------- | :------ | :-------- |
| **Entire Messaging Module (Combined)**                               | **59.52%**     | **4,140**     | **2,181** | **283** | **1,676** |
| **Backend Domain (`src/backend/messaging/domain/`)**                 | **90.46%**     | **304**       | **189**   | **86**  | **29**    |
| ├─ `messaging.message.entity.ts`                                     | 100.00%        | 6             | 3         | 3       | 0         |
| ├─ `messaging.room.entity.ts`                                        | 98.44%         | 64            | 51        | 12      | **1**     |
| ├─ `messaging.receipt.ts`                                            | 89.74%         | 39            | 35        | 0       | **4**     |
| └─ `messaging.value-objects.ts`                                      | 87.69%         | 195           | 100       | 71      | **24**    |
| **Backend Application (`src/backend/messaging/application/`)**       | **71.77%**     | **418**       | **278**   | **22**  | **118**   |
| ├─ `messaging.receipt.use-case.ts`                                   | 94.44%         | 36            | 34        | 0       | **2**     |
| ├─ `messaging.access.ts`                                             | 88.24%         | 34            | 25        | 5       | **4**     |
| ├─ `messaging.receipts-list.use-case.ts`                             | 80.00%         | 10            | 8         | 0       | **2**     |
| ├─ `messaging.send-message.use-case.ts`                              | 75.00%         | 36            | 14        | 13      | **9**     |
| ├─ `messaging.rooms.use-case.ts`                                     | 71.19%         | 59            | 38        | 4       | **17**    |
| ├─ `messaging.history.use-case.ts`                                   | 69.81%         | 106           | 74        | 0       | **32**    |
| └─ `messaging.keys.use-case.ts`                                      | 62.04%         | 137           | 85        | 0       | **52**    |
| **Backend Infrastructure (`src/backend/messaging/infrastructure/`)** | **86.78%**     | **174**       | **142**   | **9**   | **23**    |
| ├─ `messaging.keys.postgresql.ts`                                    | 91.67%         | 24            | 22        | 0       | **2**     |
| ├─ `messaging.messages.postgresql.ts`                                | 90.20%         | 51            | 42        | 4       | **5**     |
| ├─ `messaging.receipts.postgresql.ts`                                | 86.96%         | 23            | 19        | 1       | **3**     |
| └─ `messaging.rooms.postgresql.ts`                                   | 82.89%         | 76            | 59        | 4       | **13**    |
| **Backend Presentation (`src/backend/messaging/presentation/`)**     | **75.47%**     | **587**       | **283**   | **160** | **144**   |
| ├─ `messaging.socket.frames.ts`                                      | 86.84%         | 114           | 65        | 34      | **15**    |
| ├─ `messaging.controller.ts`                                         | 80.00%         | 100           | 80        | 0       | **20**    |
| ├─ `messaging.socket.gateway.ts`                                     | 73.08%         | 338           | 134       | 113     | **91**    |
| ├─ `messaging.socket.connection.ts`                                  | 65.38%         | 26            | 4         | 13      | **9**     |
| └─ `messaging.socket.scheduler.ts`                                   | **0.00%**      | 9             | 0         | 0       | **9**     |
| **Frontend Crypto, Connection, Search & Presentation**               | **65.59%**     | **1,212**     | **789**   | **6**   | **417**   |
| ├─ `messaging.backoff.ts` / `chat.history.ts`                        | 100.00%        | 31            | 31        | 0       | 0         |
| ├─ `messaging.outbox.ts`                                             | 96.97%         | 33            | 32        | 0       | **1**     |
| ├─ `chat.typing.ts`                                                  | 96.15%         | 78            | 75        | 0       | **3**     |
| ├─ `chat.status.ts`                                                  | 92.31%         | 26            | 24        | 0       | **2**     |
| ├─ `messaging.message-status.ts`                                     | 91.30%         | 23            | 21        | 0       | **2**     |
| ├─ `messaging.crypto.primitives.ts`                                  | 86.15%         | 65            | 56        | 0       | **9**     |
| ├─ `chat.read-receipts.ts`                                           | 85.19%         | 54            | 46        | 0       | **8**     |
| ├─ `messaging.outbox-flusher.ts`                                     | 83.21%         | 137           | 108       | 6       | **23**    |
| ├─ `chat.view-model.ts`                                              | 81.37%         | 102           | 83        | 0       | **19**    |
| ├─ `messaging.crypto.session.ts`                                     | 80.00%         | 60            | 48        | 0       | **12**    |
| ├─ `messaging.connection.ts`                                         | 76.85%         | 203           | 156       | 0       | **47**    |
| ├─ `messaging.crypto.sender-keys.ts`                                 | 72.88%         | 59            | 43        | 0       | **16**    |
| ├─ `messaging.search.ts`                                             | 38.52%         | 135           | 52        | 0       | **83**    |
| ├─ `messaging.crypto.key-store.ts`                                   | 16.67%         | 84            | 14        | 0       | **70**    |
| ├─ `messaging.browser.ts`                                            | **0.00%**      | 36            | 0         | 0       | **36**    |
| └─ `messaging.outbox.indexed-db.ts`                                  | **0.00%**      | 86            | 0         | 0       | **86**    |
| **Frontend Application & Entry (`src/frontend/messaging/`)**         | **34.60%**     | **1,445**     | **500**   | **0**   | **945**   |
| ├─ `chat.epochs.ts`                                                  | 93.90%         | 82            | 77        | 0       | **5**     |
| ├─ `chat.api.ts`                                                     | 85.61%         | 139           | 119       | 0       | **20**    |
| ├─ `chat.session.ts`                                                 | 67.50%         | 80            | 54        | 0       | **26**    |
| ├─ `chat.api.guards.ts`                                              | 43.66%         | 142           | 62        | 0       | **80**    |
| ├─ `chat.controller.ts`                                              | 28.92%         | 650           | 188       | 0       | **462**   |
| └─ `chat.page.ts`                                                    | **0.00%**      | 352           | 0         | 0       | **352**   |

---

## 3. Recommended Remediation Plan

1. **Fix Cross-Room Idempotency & Stale Epoch Races (`SendMessageUseCase` / `PostgresMessageRepository` / `sql/index.sql`)**:
   - In `SendMessageUseCase.execute` (after `this.messages.append`), verify `message.roomId === room.value.id`; if not, return `err(new ConflictError('idempotencyKey was already used for another message'))`.
   - Enforce `NEW.key_epoch = (SELECT key_epoch FROM rooms WHERE id = NEW.room_id)` inside the `messages_assert_sender_is_member` trigger.
2. **Guard `PostgresSenderKeyRepository.store` and `PostgresReceiptRepository.advance` Against Concurrent Room Leave**:
   - Map `SQLSTATE 23503` in `PostgresSenderKeyRepository.store` and catch domain errors in `StoreSenderKeysUseCase.execute` so concurrent membership changes return `Result.err(...)` (403/409) instead of an unhandled 500 error.
   - Throw `ForbiddenError` instead of a generic `Error` in `PostgresReceiptRepository.advance` when `!row`, and catch it in `ReceiptUseCase.execute`.
3. **Fix E2EE Late Identity-Key Lockout (`EpochKeeper` & `SenderKeySession`)**:
   - Do not mark an epoch permanently prepared in `EpochKeeper` if `roomKeys` is missing members of `room.memberIds`, or allow wrapping/rotating the sender's chain key when a member publishes their identity key.
4. **Fix Outbox Livelock & Multi-Tab `ChainIndex` Recovery (`ChatController` & `OutboxFlusher`)**:
   - Always refresh room summaries (`await this.#reloadRooms()`) in `ChatController.#onReady` and upon receiving a `conflict` error before retrying encryption.
5. **Fix `HistoryUseCase` Boundaries & Single-Field Validation Tests**:
   - Reject `since >= until` and pre-1970 negative timestamps; handle `since === 0` without excluding millisecond `0`.
   - Add isolated single-field validation tests, boundary tests (`limit = 1`, `limit = 100`, `MemberId = MAX_INT32`, UUID anchor prefix/suffixes, strict base64 padding), fault-injection DB tests, and E2E tests for `/api/keys/identity`, `/api/rooms/:roomId/sender-keys`, `/api/rooms/:roomId/members`, and `/api/rooms/:roomId/receipts`.
