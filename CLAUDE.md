# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack constraints

- Runtime, bundler, test runner, linter, and formatter: **Bun canary**. `bun lint` and `bun fmt` are not in stable Bun yet (1.4.4), so local and CI both use canary. Switch CI to `latest` once they ship in stable.
- TypeScript **7.1.0-beta**, installed locally. Type checking runs through its `tsc --noEmit`.
- The only runtime dependencies allowed are `jose` (JWT) and `@zxcvbn-ts/*`. Everything else uses Bun natives: `Bun.serve` routes + HTML imports for the frontend, `Bun.password` (argon2id) for password hashing, `SQL` from `bun` for Postgres, `RedisClient` from `bun` for Valkey, and `$` for shell scripts. Do not add frameworks or ORMs.
- Frontend and backend are both vanilla TypeScript in one repo. Bun bundles the frontend from the `index.html` import in `src/backend/shared/http/app.server.ts`.

## Commands

```sh
bun install
bun run dev                 # hot-reload server (needs the pod infra running)
bun fmt                     # format; CI runs `bun fmt --check`
bun lint --max-warnings 0   # CI fails on warnings
bun run typecheck
bun run test:unit           # src/**/*.test.ts
bun run test:integration    # test/integration, needs Postgres + Valkey
bun run test:e2e            # test/e2e, starts the real server on port 0
bun run test:load smoke     # k6 (grafana/k6:2.4.0 via Podman) against a running server; `load` for the 2-minute profile
bun test path/to/file.test.ts -t "test name"   # single test
bun run verify              # fmt check + lint + typecheck + unit (same as the CI quality job)
```

Do not add `lint` or `fmt` scripts to package.json: `bun lint` runs a package.json `lint` script when one exists, so a script named `lint` that calls `bun lint` would call itself forever.

## Local infrastructure (Podman pod, no Containerfiles)

`scripts/pod.ts` builds a `chat-rsa` pod from upstream images (`postgres:18-alpine`, `valkey/valkey:9.2-alpine`, `oven/bun:canary`):

- `bun run pod:infra` starts only Postgres and Valkey (for `bun run dev` on the host and for integration/e2e tests).
- `bun run pod:up` also starts the app container, which mounts the repo.
- `pod:down`, `pod:status`, and `pod:logs` do what their names say.

Host ports default to 3001, 5433, and 6380 so they don't collide with other projects' pods. Override them with `POD_APP_PORT`, `POD_DB_PORT`, and `POD_CACHE_PORT`. The defaults in `src/backend/shared/config/env.config.ts` point at those host ports. Containers in the pod reach each other on `localhost` at the standard ports.

`sql/` is mounted into Postgres' `docker-entrypoint-initdb.d`, which only runs on an empty volume, so `main.ts` also applies `sql/index.sql` (idempotent `IF NOT EXISTS`) at startup. Sign-in tokens are HS256 JWTs signed with `JWT_SECRET`; the dev default is refused when `NODE_ENV=production`.

## Architecture

Screaming + Clean architecture: features at the top level, Clean layers inside each feature, and files named `<feature>.<responsibility>.ts`.

```
src/
  backend/<feature>/
    domain/          ports and entities (no imports from other layers)
    application/     use cases that depend only on domain ports
    infrastructure/  adapters implementing ports (Bun SQL, RedisClient, …)
    presentation/    HTTP controllers that return Response
  backend/shared/    cross-feature config and the HTTP server factory
  backend/main.ts    composition root: builds the adapters and injects them into createServer
  frontend/<feature>/presentation/   pure view logic (unit-testable without a DOM)
  frontend/index.html                home page (static)
  frontend/auth/                     sign-in.html and sign-up.html (served at /sign-in and /sign-up), auth.css, auth.form.ts (the only JS: submits the form as JSON)
  frontend/messaging/                chat.html (served at /chat), crypto/, connection/, search/, application/, presentation/
  shared/contracts/  types shared by frontend and backend
test/
  integration/       adapters against real services (*.integration.test.ts)
  e2e/               full HTTP server (*.e2e.test.ts)
```

- Dependencies point inward: presentation → application → domain. Infrastructure implements domain ports, and only `main.ts` (or a test) wires infrastructure in.
- `createServer` takes its dependencies (port, adapters) as arguments, so e2e tests run it with `port: 0`. A new feature adds its routes there and receives its adapters from `main.ts`.
- Unit tests sit next to the file as `*.test.ts` and use fake ports, never real services.
- Route guards: guarded pages start with `<html data-guard="pending">` plus an inline `<style>` in their `<head>` that hides the body; it must stay inline (an external stylesheet can arrive after the first paint), and `test/e2e/pages.guard.e2e.test.ts` checks it. `bun --hot` does not reload edited `.html` files: restart the dev server after changing one. Their script calls `enforceAccess('members' | 'guests')` from `frontend/auth/auth.page-guard.ts` (decision in `auth/presentation/auth.guard.ts`) and `revealPage()` only when the visitor may stay; the chat reveals itself only after the server accepted the token. A new guarded page needs both the attribute and the call.
- Frontend pages lean on the platform: native constraint validation (`required`, `pattern`, `maxlength`, `autocomplete`) mirrors the server rules, and CSS (`:user-invalid`, `:empty`, `[aria-busy]`) draws every state. JS is limited to submitting forms with `fetch`, because the API accepts `application/json` only (415 otherwise, as a CSRF guard). Keep page logic that can be tested without a DOM in `frontend/<feature>/presentation/`.

## Messaging (E2EE rooms)

Spec and decisions: `odd/tasks/messages.md`. Wire contracts: `src/shared/contracts/messaging.contract.ts` (REST) and `messaging.socket.contract.ts` (WebSocket frames, close codes, subprotocol auth).

- Transport split: WebSocket `/ws` carries live messages, ACKs, typing, presence and read receipts. REST under `/api/rooms`, `/api/keys`, `/api/users` and `/api/auth/refresh` carries history, keys, membership and lookups. The composition is in `src/backend/app.composition.ts`, shared by `main.ts` and `test/e2e/messaging.e2e.test.ts`.
- Socket auth: `new WebSocket(url, ['chat-rsa.v1', 'bearer.<jwt>'])`. The server answers only `chat-rsa.v1`. A mid-session `auth.refresh` frame replaces the token; a failure closes with 4001. Heartbeat pings close a silent socket with 4008. SIGTERM drains in this order: stop upgrades, await in-flight sends, close with 1001, stop HTTP, close pools (`installShutdown` in `shared/lifecycle`).
- Ordering and idempotency: PostgreSQL generates every message id (`uuidv7()`), and `created_at` is derived from it. Clients never send ids or timestamps. `UNIQUE (sender_id, idempotency_key)` makes retries return the stored original (`duplicate: true`, no second fan-out).
- Receipts are per-member watermarks on `room_members` (`last_delivered_message_id`, `last_read_message_id`). They only move forward, and reading implies delivered. The client sends `read` only for messages an IntersectionObserver saw on screen.
- Room bounds 2..100: a locked counter with an immediate max check, plus a deferred min check at COMMIT. Each join/leave bumps `rooms.key_epoch`, and sends with a stale epoch are refused (409).
- E2EE (`src/frontend/messaging/crypto`): X25519 + HKDF-SHA256 + AES-256-GCM via Web Crypto only. Sender Keys use one chain key per (room, epoch, sender), wrapped per recipient with an ephemeral X25519 key. Private keys are non-extractable `CryptoKey`s in IndexedDB. The server stores only `ciphertext`/`iv`/`auth_tag`, so search runs client-side over the decrypted local store (`frontend/messaging/search`).
- Client resilience (`src/frontend/messaging/connection`): full-jitter exponential backoff (1 s base, 30 s cap), immediate reconnect on `online`, an IndexedDB outbox flushed strictly in order, one ack at a time.
- Zero-trust HTTP: `readJsonObject`/`readQuery` reject unknown keys, a wrong content type and bodies over 64 KiB. The guard in `shared/http/http.guard.ts` runs an IP token bucket, then the JWT, then a user token bucket. Buckets live in Valkey (Lua script, same math as `shared/domain/token-bucket.ts`) and are configured with `RATE_LIMIT_IP_CAPACITY`, `RATE_LIMIT_IP_REFILL`, `RATE_LIMIT_USER_CAPACITY` and `RATE_LIMIT_USER_REFILL` (defaults 120/20 and 60/10). Sign-in and sign-up are behind the IP bucket too, so the k6 `stress` profile from one IP now also hits 429s.
- Sessions: every JWT carries a `sid` that `/api/auth/refresh` keeps. `POST /api/auth/sign-out` revokes the session in Valkey (`revoked-session:<sid>`, one token lifetime), `RevocationAwareTokenVerifier` refuses its tokens everywhere (fails closed), and the gateway closes its sockets with 4001. The chat page's Sign out button clears the token and replaces the location with `/sign-in`; per-user E2EE keys and the decrypted store stay on the device so the chat is readable after signing in again. `GET /api/rooms/:roomId/members` gives members the names of the other members.
- Room authorization: every REST route and every room frame re-checks membership through `roomOfMember`. A missing room answers like a forbidden one (403), so room ids cannot be probed.

## Load testing (k6)

`test/load/auth.load.ts` is a k6 script (k6 runs TypeScript natively; only `@types/k6` is installed, for tsc and lint). `bun run test:load [smoke|load|stress]` runs it through `test/load/k6-runner.ts` from the pinned `grafana/k6` image with `--network host` against `LOAD_BASE_URL` (default `http://localhost:$PORT`), then deletes exactly the users the run created (`^load<runId>[pum][0-9]+$`). k6 exits 99 when a threshold fails, and the script keeps that exit code.

- Each request declares its own expected statuses (`responseCallback`), so a 401 on a valid sign-in counts as a failed request. Never go back to a global `setResponseCallback`.
- `bun run test:load:probes` runs the script against `test/load/support/fake-auth-server.ts` with one deliberate defect per case, and asserts that k6 catches it. Add a sabotage whenever you add a check.
- Capacity is bounded by argon2 (`Bun.password`, argon2id, 64 MiB, t=2, p=1): about 19 operations/s on 8 cores when concurrent, at about 140 ms each. Every sign-up, sign-in, wrong-password and unknown-user check costs one operation. `load` asks for about 7/s and passes. `stress` (a 30-VU spike) saturates on purpose and fails its latency threshold (p95 about 3 s). With the IP token bucket on sign-in and sign-up (see Messaging), a single-IP spike past the burst also gets 429s; raise `RATE_LIMIT_IP_*` for load runs.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. The `quality` job runs fmt check, lint, typecheck, and unit tests. After it passes, the `integration` job runs integration and e2e tests against Postgres and Valkey service containers. To block merges until both jobs pass, mark them as required status checks in the GitHub branch protection settings.
