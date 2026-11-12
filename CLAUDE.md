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
  shared/contracts/  types shared by frontend and backend
test/
  integration/       adapters against real services (*.integration.test.ts)
  e2e/               full HTTP server (*.e2e.test.ts)
```

- Dependencies point inward: presentation → application → domain. Infrastructure implements domain ports, and only `main.ts` (or a test) wires infrastructure in.
- `createServer` takes its dependencies (port, adapters) as arguments, so e2e tests run it with `port: 0`. A new feature adds its routes there and receives its adapters from `main.ts`.
- Unit tests sit next to the file as `*.test.ts` and use fake ports, never real services.
- Frontend pages lean on the platform: native constraint validation (`required`, `pattern`, `maxlength`, `autocomplete`) mirrors the server rules, and CSS (`:user-invalid`, `:empty`, `[aria-busy]`) draws every state. JS is limited to submitting forms with `fetch`, because the API accepts `application/json` only (415 otherwise, as a CSRF guard). Keep page logic that can be tested without a DOM in `frontend/<feature>/presentation/`.

## Load testing (k6)

`test/load/auth.load.ts` is a k6 script (k6 runs TypeScript natively; only `@types/k6` is installed, for tsc and lint). `bun run test:load [smoke|load|stress]` runs it through `test/load/k6-runner.ts` from the pinned `grafana/k6` image with `--network host` against `LOAD_BASE_URL` (default `http://localhost:$PORT`), then deletes exactly the users the run created (`^load<runId>[pu][0-9]+$`). k6 exits 99 when a threshold fails, and the script keeps that exit code.

- Each request declares its own expected statuses (`responseCallback`), so a 401 on a valid sign-in counts as a failed request. Never go back to a global `setResponseCallback`.
- `bun run test:load:probes` runs the script against `test/load/support/fake-auth-server.ts` with one deliberate defect per case, and asserts that k6 catches it. Add a sabotage whenever you add a check.
- Capacity is bounded by argon2 (`Bun.password`, argon2id, 64 MiB, t=2, p=1): about 19 operations/s on 8 cores when concurrent, at about 140 ms each. Every sign-up, sign-in, wrong-password and unknown-user check costs one operation. `load` asks for about 7/s and passes. `stress` (a 30-VU spike) saturates on purpose and fails its latency threshold (p95 about 3 s, 0 errors): the endpoints have no rate limiting.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. The `quality` job runs fmt check, lint, typecheck, and unit tests. After it passes, the `integration` job runs integration and e2e tests against Postgres and Valkey service containers. To block merges until both jobs pass, mark them as required status checks in the GitHub branch protection settings.
