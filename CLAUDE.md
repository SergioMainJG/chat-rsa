# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack constraints

- Runtime, bundler, test runner, linter, and formatter: **Bun canary**. `bun lint` and `bun fmt` are not in stable Bun yet (1.4.4), so local and CI both use canary. Switch CI to `latest` once they ship in stable.
- TypeScript **7.1.0-beta**, installed locally. Type checking runs through its `tsc --noEmit`.
- The only runtime dependencies allowed are `jose` (JWT), `argon2`, and `@zxcvbn-ts/*`. Everything else uses Bun natives: `Bun.serve` routes + HTML imports for the frontend, `SQL` from `bun` for Postgres, `RedisClient` from `bun` for Valkey, and `$` for shell scripts. Do not add frameworks or ORMs.
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
  frontend/main.ts + index.html      browser entry
  shared/contracts/  types shared by frontend and backend
test/
  integration/       adapters against real services (*.integration.test.ts)
  e2e/               full HTTP server (*.e2e.test.ts)
```

- Dependencies point inward: presentation → application → domain. Infrastructure implements domain ports, and only `main.ts` (or a test) wires infrastructure in.
- `createServer` takes its dependencies (port, probes) as arguments, so e2e tests run it with `port: 0`. A new feature adds its routes there and receives its adapters from `main.ts`.
- Unit tests sit next to the file as `*.test.ts` and use fake ports, never real services.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. The `quality` job runs fmt check, lint, typecheck, and unit tests. After it passes, the `integration` job runs integration and e2e tests against Postgres and Valkey service containers. To block merges until both jobs pass, mark them as required status checks in the GitHub branch protection settings.
