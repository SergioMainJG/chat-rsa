# Adversarial QA Report: Frontend Messaging

**Method**: White-box & gray-box mutation testing using `@stryker-mutator/core` (v10.1.1) in an isolated `/tmp/stryker-qa` workspace (no project files modified), alongside `bun run test:unit` (698 pass), `bun run test:integration` (100 pass), and `bun run test:e2e` (119 pass).

## 1. `src/frontend/messaging/crypto/messaging.crypto.sender-keys.ts` (72.88% mutation score)

- **Attack**: Mutated base64 decoding checks (`authTag === null || ciphertext === null || iv === null` at line 146) to `false || iv === null`, and mutated `Uint8Array.fromBase64(text, { lastChunkHandling: 'strict' })` at line 158 to `{}`.
- **What failed**: **16 mutants survived** while `bun test ./src/frontend/messaging` passed 100%.
- **How it failed**:
  - No unit test passes malformed base64 specifically in `authTag` or `ciphertext` (only `iv` or tampered bytes), so `authTag === null` and `ciphertext === null` branches are unverified.
  - `lastChunkHandling: 'strict'` is not tested with non-canonical base64 padding, so `{}` survives.
- **Expected**: Unit tests for invalid base64 in each of `authTag`, `ciphertext`, `iv`, and non-strict base64 padding.

## 2. `src/frontend/messaging/connection/messaging.outbox-flusher.ts` (86.08% mutation score)

- **Attack**: Mutated `#requests += 1` (line 92) to `#requests -= 1`; mutated `if (!this.#deps.connection.isOpen() || !this.#deps.connection.send(frame))` (line 151) body to `{}`; mutated `this.#settle({ kind: 'reconnected' })` (line 123) to `{}`.
- **What failed**: **22 mutants survived** (plus 15 timeouts).
- **How it failed**:
  - `#requests += 1` -> `-= 1` still produces `this.#requests !== requests` in `#drain()`, so the loop condition cannot distinguish increment from decrement.
  - The disconnect-on-send guard (`!isOpen() || !send(frame)`) has an empty-block mutant surviving, meaning `onStop` with `reason: 'disconnected'` from a closed/failing `send()` is not asserted in that path.
  - `reconnected` payload `{ kind: 'reconnected' }` mutated to `{}` still hits `default: return false` or doesn't fail an assertion.
- **Expected**: Explicit assertions on `onStop` when `connection.isOpen()` is false or `connection.send()` returns false, and on `reconnected` resending the in-flight item.

## 3. `src/frontend/messaging/presentation/chat.read-receipts.ts` (85.19% mutation score)

- **Attack**: Mutated `if (read !== null && (current === undefined || read > current))` at line 36 to `read !== null && (current === undefined || false)` and `read >= current`.
- **What failed**: **8 mutants survived**.
- **How it failed**: `seed` when `current` is already defined and `read > current` (moving the watermark forward via `seed`) is not covered by unit tests.
- **Expected**: A unit test calling `seed(roomId, id1)` followed by `seed(roomId, id2)` where `id2 > id1` and verifying `take` suppresses `id2`.
