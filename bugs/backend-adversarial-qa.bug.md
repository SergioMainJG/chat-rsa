# Adversarial QA Report: Backend (`shared` & `user`)

**Method**: White-box & gray-box mutation testing using `@stryker-mutator/core` (v10.1.1) in an isolated `/tmp/stryker-qa` workspace (no project files modified), alongside `bun run test:unit`, `bun run test:integration`, and `bun run test:e2e` (all passing: 698 unit, 100 integration, 119 e2e).

## 1. `src/backend/shared/http/http.origin.ts` — `hasAllowedOrigin` (60.00% mutation score)
- **Attack**: Mutated `hasAllowedOrigin(request, origins)` in `http.origin.ts:14-16` with `ConditionalExpression` (`return true;`, `return false;`), `LogicalOperator` (`origin !== null || origins.includes(origin)`), `EqualityOperator` (`origin === null`), and `BlockStatement` (`{}`).
- **What failed**: **6 of 15 mutants survived** while `bun test ./src/backend/shared` passed 100%.
- **How it failed**: `hasAllowedOrigin` has zero direct unit test coverage in `src/backend/shared/http/`. Replacing the entire function body with `{}` or `return true;` does not break any unit test.
- **Expected**: Unit tests should directly exercise `hasAllowedOrigin` with: matching origin, missing `Origin` header (`null`), and foreign `Origin` header, killing all 6 mutants.

## 2. `src/backend/shared/http/http.guard.ts` — `clientIpOf` & `bearerTokenOf` (89.42% mutation score)
- **Attack**: Mutated `if (isIP(forwarded) !== 0)` at `http.guard.ts:125` to `if (true)`, and mutated `BEARER = /^Bearer (?<token>\S+)$/iu` at `http.guard.ts:90` to remove the `^` anchor.
- **What failed**: **11 mutants survived** in `http.guard.ts`, including `if (true)` on `isIP(forwarded) !== 0` and the unanchored `BEARER` regex.
- **How it failed**:
  - When a trusted proxy sends a missing or malformed `CF-Connecting-IP` header (e.g. `not-an-ip` or `""`), `isIP(forwarded) !== 0` is supposed to reject it and fall back to `peer`. Because no unit test sends an invalid `CF-Connecting-IP` from a trusted proxy, `if (true)` survives.
  - Because no unit test sends `Authorization: Foo Bearer abc`, removing `^` from `BEARER` survives.
- **Expected**: Unit tests for `clientIpOf` with a trusted proxy + invalid/empty `CF-Connecting-IP`, and `bearerTokenOf` with a non-leading `Bearer` token.

## 3. `src/backend/shared/http/http.json-body.ts` — `Content-Length` pre-check (86.46% mutation score)
- **Attack**: Mutated `if (Number(request.headers.get('content-length') ?? 0) > max)` at `http.json-body.ts:36` to `if (false)` and `>= max`.
- **What failed**: **13 mutants survived** in `http.json-body.ts`.
- **How it failed**: The fast-path `Content-Length` header check (before streaming the body) is never exercised independently of the streaming byte counter, so `if (false)` passes all unit tests.
- **Expected**: A unit test with an oversized `Content-Length` header on an empty/small stream (or spy on `request.body` not being consumed) to kill `if (false)` and `>= max`.

## 4. `src/backend/shared/domain/token-bucket.ts` — Refill arithmetic (95.83% mutation score)
- **Attack**: Mutated `previous.tokens + elapsedSeconds * policy.refillPerSecond` at `token-bucket.ts:33` to `elapsedSeconds / policy.refillPerSecond`.
- **What failed**: **1 mutant survived** (`*` -> `/`).
- **How it failed**: Unit tests use `refillPerSecond: 1` (identity for `*` and `/`), so dividing by `1` produces the exact same result as multiplying by `1`.
- **Expected**: Test `takeToken` with `refillPerSecond !== 1` (e.g., `2` or `0.5`).

## 5. `src/backend/user/application/user.refresh.use-case.ts` — Claim validation (92.31% mutation score)
- **Attack**: Mutated `if (!claims || !name?.ok)` at `user.refresh.use-case.ts:41` to `if (!claims && !name?.ok)`.
- **What failed**: **2 mutants survived** (`||` -> `&&`, and `name?.ok` -> `name.ok`).
- **How it failed**: No unit test passes a verified token whose `claims.name` fails `UserName.create` (e.g., invalid characters or empty string).
- **Expected**: A unit test where `verifier.verify` returns claims with an invalid `name` and asserts `UnauthorizedError`.

## 6. `src/backend/user/domain/user.value-objects.ts` — Length boundaries in unit tests (90.00% mutation score)
- **Attack**: Mutated `if (raw.length > MAX_NAME_LENGTH)` (line 48) to `if (false)` / `>= MAX_NAME_LENGTH`, and `if (raw.length > MAX_PASSWORD_LENGTH)` (line 95) to `>= MAX_PASSWORD_LENGTH`.
- **What failed**: **8 mutants survived** in `bun test ./src/backend/user`.
- **How it failed**: Although e2e tests (`test/e2e/user.input-length.e2e.test.ts`) cover length boundaries, the unit test suite (`src/backend/user/`) does not test `MAX_NAME_LENGTH` (64) or `MAX_PASSWORD_LENGTH` (256) boundaries.
- **Expected**: Direct unit tests at `64`, `65`, `256`, and `257` characters.
