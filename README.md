# chat-rsa (Komwasai)

End-to-end encrypted messaging web application built with vanilla TypeScript on Bun, PostgreSQL, and Valkey. Messages are encrypted client-side using Web Crypto (X25519, HKDF-SHA256, AES-256-GCM) so the server stores only ciphertext.

## Quick Start

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create a `.env` file with a signing secret of at least 32 characters:

   ```sh
   printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 32)" > .env
   ```

3. Start local PostgreSQL and Valkey via Podman:

   ```sh
   bun run pod:infra
   ```

4. Start the development server:

   ```sh
   bun run dev
   ```

5. Open `http://localhost:3000` in your browser.

## Prerequisites and Dependencies

### System Requirements

| Requirement | Version / Image            | Purpose                                                                   |
| ----------- | -------------------------- | ------------------------------------------------------------------------- |
| Bun         | canary (`bun@1.4.4`+)      | Runtime, bundler, test runner, `bun lint`, and `bun fmt`                  |
| Podman      | latest                     | Local PostgreSQL, Valkey, and k6 load-test containers                     |
| PostgreSQL  | `postgres:18-alpine`       | Primary database (managed by `pod:infra` or external)                     |
| Valkey      | `valkey/valkey:9.2-alpine` | Rate limiting and session revocation (managed by `pod:infra` or external) |

### Project Dependencies

Runtime dependencies are intentionally minimal; HTTP, WebSockets, SQL, Redis/Valkey, password hashing (Argon2id), and frontend bundling use Bun built-ins.

| Package                      | Scope       | Purpose                                        |
| ---------------------------- | ----------- | ---------------------------------------------- |
| `jose`                       | Runtime     | HS256 JWT signing and verification             |
| `@zxcvbn-ts/core`            | Runtime     | Password strength evaluation                   |
| `@zxcvbn-ts/language-common` | Runtime     | Common dictionary for password strength checks |
| `@types/bun`                 | Development | Bun runtime type definitions                   |
| `typescript` (`7.1.0-beta`)  | Development | Static type checking via `tsc --noEmit`        |

## Configuration

Bun automatically loads `.env` from the repository root. Only `JWT_SECRET` is required outside `NODE_ENV=test`.

### Application Environment Variables

| Variable                     | Required | Default                                           | Description                                                                                                         |
| ---------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                 | Yes      | None (test fallback only when `NODE_ENV=test`)    | HS256 signing secret, minimum 32 characters                                                                         |
| `PORT`                       | No       | `3000`                                            | HTTP server port                                                                                                    |
| `DATABASE_URL`               | No       | `postgres://chat:chat@localhost:5433/chat`        | PostgreSQL connection string                                                                                        |
| `VALKEY_URL`                 | No       | `redis://localhost:6380`                          | Valkey/Redis connection string                                                                                      |
| `APP_ORIGINS`                | No       | `http://localhost:<PORT>,http://127.0.0.1:<PORT>` | Comma-separated allowed origins for CSRF and `/ws` upgrades; first entry is used as the public origin in production |
| `TRUSTED_PROXY_IPS`          | No       | Empty                                             | Comma-separated proxy peer IPs whose `CF-Connecting-IP` header is trusted (`X-Forwarded-For` is always ignored)     |
| `SESSION_MAX_AGE_SECONDS`    | No       | `604800` (7 days)                                 | Absolute session lifetime; refresh is rejected after this age                                                       |
| `RATE_LIMIT_IP_CAPACITY`     | No       | `120`                                             | Per-IP HTTP token bucket capacity                                                                                   |
| `RATE_LIMIT_IP_REFILL`       | No       | `20`                                              | Per-IP HTTP token bucket refill rate (tokens/second)                                                                |
| `RATE_LIMIT_USER_CAPACITY`   | No       | `60`                                              | Per-user HTTP token bucket capacity                                                                                 |
| `RATE_LIMIT_USER_REFILL`     | No       | `10`                                              | Per-user HTTP token bucket refill rate (tokens/second)                                                              |
| `RATE_LIMIT_SIGNIN_CAPACITY` | No       | `10`                                              | Per-account sign-in throttle capacity                                                                               |
| `RATE_LIMIT_SIGNIN_REFILL`   | No       | `0.0333...` (`1/30`)                              | Per-account sign-in throttle refill rate (tokens/second)                                                            |

### Local Pod Environment Variables

`scripts/pod.ts` publishes all ports on `127.0.0.1` by default. Port mappings are fixed when the pod is created; run `bun run pod:down` before changing them.

| Variable         | Default     | Description                                                         |
| ---------------- | ----------- | ------------------------------------------------------------------- |
| `POD_APP_PORT`   | `3001`      | Host port mapped to container port `3000`                           |
| `POD_DB_PORT`    | `5433`      | Host port mapped to PostgreSQL port `5432`                          |
| `POD_CACHE_PORT` | `6380`      | Host port mapped to Valkey port `6379`                              |
| `POD_APP_BIND`   | `127.0.0.1` | Host bind address for the app port (set `0.0.0.0` to expose on LAN) |

Database schema initialization (`sql/index.sql`) runs automatically on startup and is idempotent (`IF NOT EXISTS`).

## Development Workflow

### Local Infrastructure

| Command              | Action                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| `bun run pod:infra`  | Start PostgreSQL and Valkey containers only (for host `bun run dev` and tests) |
| `bun run pod:up`     | Start PostgreSQL, Valkey, and the containerized app (`oven/bun:canary`)        |
| `bun run pod:status` | Show pod status                                                                |
| `bun run pod:logs`   | Follow logs for all containers in the pod                                      |
| `bun run pod:down`   | Remove the pod and its containers                                              |

Note: `bun --hot` reloads TypeScript changes automatically, but edited `.html` files require restarting `bun run dev`.

### Verification and Testing

Run the full quality gate before opening a pull request:

```sh
bun run verify
```

Individual commands:

| Command                     | Scope                                                                                           | Requires Pod Infra |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| `bun fmt`                   | Format source files                                                                             | No                 |
| `bun fmt --check`           | Check formatting without modifying files                                                        | No                 |
| `bun lint --max-warnings 0` | Lint source files (zero warnings allowed)                                                       | No                 |
| `bun run typecheck`         | Run TypeScript (`tsc --noEmit`)                                                                 | No                 |
| `bun run test:unit`         | Run unit tests (`src/**/*.test.ts`)                                                             | No                 |
| `bun run test:integration`  | Run integration tests (`test/integration/`)                                                     | Yes                |
| `bun run test:e2e`          | Run end-to-end tests (`test/e2e/`) against a real server on port `0`                            | Yes                |
| `bun run test:load smoke`   | Run k6 smoke test via Podman against a running server (`load` or `stress` for heavier profiles) | Yes                |
| `bun run test:load:probes`  | Run k6 sabotage probes against fake servers                                                     | No                 |

Run a single test file or case:

```sh
bun test path/to/file.test.ts -t "test name"
```

### Build and Production

```sh
bun run build
NODE_ENV=production bun run start
```

In production (`NODE_ENV=production`), `src/backend/main.ts` bundles all HTML pages once at startup with security headers, precompressed brotli/gzip responses, and ETag revalidation.

### Continuous Integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

1. `quality`: formatting check (`bun fmt --check`), linting (`bun lint --max-warnings 0`), type checking (`bun run typecheck`), and unit tests (`bun run test:unit`).
2. `integration`: runs after `quality` passes, executing integration and end-to-end tests against PostgreSQL and Valkey service containers.
