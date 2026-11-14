# Security Audit Report — `chat-rsa` (Run 2)

## 1. Run Metadata & Coverage Statement
- **Run ID**: `chat-rsa-run-2`
- **Profile / Scope**: `standard` — full repository (`src/`, `test/`, `scripts/`, `sql/`, `.github/`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `CLAUDE.md`)
- **Source Ref**: `feat/messages` (`7a4ba20be4e5351c2e8679d2f7c0f08803a3ff5b`, dirty worktree; manifest SHA-256 `afb433e29557e6644ffaadda7174e50a0c2cacca82681fed22345c00637de65e`)
- **Execution Policy**: `sandboxed-source-and-local-only` (`bwrap --unshare-all`, cleared env, read-only `/target`, tmpfs `/work`, `systemd-run` 768 MiB / 64 tasks / 100% CPU, 60s timeout). No PostgreSQL or Valkey servers run inside the sandbox; DB/Valkey-dependent paths were evaluated via source inspection and in-memory unit harnesses.
- **Prior Run**: `chat-rsa-run-1` (`bde5b88d`, `feat/users`, `incomplete`). All 6 prior covered units had changed source and were revalidated; all 17 prior deferred units were executed; 14 new units were seeded for messaging, WebSockets, session lifecycle, and frontend E2EE. 0 carried exclusions.
- **Coverage Summary**: 37 total units — **32 covered**, **4 candidate** (all 4 independently validated in Phase 3 and verified in Phase 5), **0 blocked**, **0 deferred**, **1 not_applicable** (`Resource and file handling`). Both the post-wave critic and the independent final-clean critic returned `stop: true` with 0 missing units and 0 reassignments.

## 2. Security Posture Summary
The `chat-rsa` backend and frontend implement strong baseline defenses across authentication, session revocation, room authorization, and WebCrypto E2EE: `JWT_SECRET` enforces >=32 characters outside `NODE_ENV=test`, `HttpOnly; Secure; SameSite=Strict` cookies pair with `APP_ORIGINS` CSRF checks on unsafe HTTP methods and `/ws` upgrades, `RevocationAwareTokenVerifier` fails closed against Valkey, and room/epoch/trigger checks enforce membership isolation.

The audit identified **1 confirmed vulnerability** (medium severity) in the browser `ChatController` where cross-sender `idempotencyKey` collisions overwrite messages and can spoof E2EE sender attribution, and **3 `needs_validation` leads** (CI `GITHUB_TOKEN` scope, Podman `0.0.0.0` port binding for unauthenticated Valkey/Postgres, and uncapped `request.json()` on auth endpoints).

## 3. Confirmed Findings

| Severity | Title | Affected Boundary | Observed Result |
| :--- | :--- | :--- | :--- |
| **medium** | Cross-Sender `idempotencyKey` Collision in `ChatController` Overwrites Messages and Spoofs E2EE Sender Attribution | `src/frontend/messaging/application/chat.controller.ts#ChatController.receive` | Reusing another member's `idempotencyKey` overwrites their entry and causes undecryptable messages from that member to render the attacker's plaintext under the victim's sender attribution. |

### `src/frontend/messaging/application/chat.controller.ts:ChatController.receive:cross-sender-idempotency-key-collision`
- **Location**: `src/frontend/messaging/application/chat.controller.ts:135, 670, 727, 805, 843`
- **Lower-Trust Principal**: Authenticated room member (`actor` in `room.members`).
- **Reproduction**: Bounded local sandbox harness (`agents/verify-idemp/artifacts/check-16.out`). Bob (`userId = 2`) sends a `message.send` frame reusing Alice's (`userId = 1`) `idempotencyKey`. When `sender-keys.available` re-evaluates Alice's undecryptable epoch-1 message, `ChatController.receive` falls back to `entries.get(key)?.text` and renders Bob's plaintext (`FORGED BY BOB: Wire funds to account 999`) under Alice's `senderId` and `id`.
- **Smallest Effective Fix**: Key `ChatController.#entries` by `${message.senderId}:${message.idempotencyKey}` (or `message.id`) and only preserve `existing.text` in `#receive` when `existing.senderId === message.senderId` and `(existing.id === null || existing.id === message.id)`.

## 4. Leads Needing Validation (`NEEDS VALIDATION`)

| Title | Repository Trace | Exact Blocker | Next Step |
| :--- | :--- | :--- | :--- |
| CI workflow executes `pull_request` code without narrowing `GITHUB_TOKEN` permissions | `.github/workflows/ci.yml:6,17,26` | Hosted GitHub Actions default `Workflow permissions` (`read-only` vs `read-write`) and branch protection on `main` are not in source. | Check GitHub repo Actions settings; add `permissions: { contents: read }` and `persist-credentials: false`. |
| Podman pod publishes unauthenticated Valkey and default-credential PostgreSQL ports without loopback host binding | `scripts/pod.ts:15,44,51` | Host network exposure and firewall rules (`nftables`/`ufw`) when running `scripts/pod.ts` are outside source. | Run `ss -tlnp` / `nft list ruleset` while pod is up; prefix `-p 127.0.0.1:...` in `scripts/pod.ts:44`. |
| Auth endpoints parse JSON bodies via uncapped `request.json()` instead of `readCappedText` | `src/backend/shared/http/app.server.ts:67`, `src/backend/user/presentation/user.controller.ts:75,79` | Deployed ingress/proxy body size limits and local sandbox `bun` path resolution. | Send a >64 KiB JSON POST to `/api/auth/sign-in` locally and check ingress `client_max_body_size`. |

## 5. Hardening Notes & Positive Patterns
- **Auth & JSON parsing**: `readCredentials` (`src/backend/user/presentation/user.controller.ts:75-86`) should use `readJsonObject(request, ['name', 'password'])` to enforce the 64 KiB cap and reject unknown keys; `JoseTokenIssuer`/`Verifier` could bind `iss`/`aud`; `chat_rsa_session` could use `__Host-` prefix over HTTPS.
- **Messaging & WS**: `FetchSenderKeysUseCase` (`messaging.keys.use-case.ts:47`) coerces empty `?keyEpoch=` to `0` via `Number()`; `SocketConnection.join` (`messaging.socket.connection.ts:57-63`) should check `this.released` after `await roomOfMember`.
- **Frontend E2EE & Storage**: Leaving a room (`#forgetRoom`) clears in-memory state and outbox items but leaves historical decrypted messages in `chat-rsa.messages.<userId>` IndexedDB; `EnvelopeRetryQueue` is in-memory only; `wrapChainKey`/`unwrapChainKey` use ephemeral X25519 without authenticating against the sender's pinned identity key during unwrap.
- **Runtime & Supply Chain**: `.impeccable/config.local.json`, `hook.cache.json`, and the 22.9 MB `impeccable` ELF binary are not in `.gitignore`; `ci.yml` and `scripts/pod.ts` use floating `canary` / tag-only image refs; `load.orchestrator.ts:50` and `scripts/pod.ts:67` index plain objects without `Object.hasOwn`.
