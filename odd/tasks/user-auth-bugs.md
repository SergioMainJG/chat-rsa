# user-auth-bugs

Objective: one strict test file per bug in `bugs/user-auth.bug.md`; RED before any source fix, GREEN after.
Branch: `feat/users` (prior user-auth work is still uncommitted, so no work-unit commits; the user decides). Test runner: `bun test` (DATABASE_URL overridden to the pod, port 5433).

## Specs

- S1 (BUG-CRITICAL-01). "`SignUpUseCase.execute` must wrap `this.users.create` in a try/catch or receive a `Result` from the repository, returning `err(new ConflictError('User already exists'))` without rejecting the promise." Also: "Enforce name uniqueness inside `InMemoryUserDatasource.create()`".
- S2 (BUG-HIGH-02). "Independent unit and e2e test cases asserting isolated validation errors for each single field."
- S3 (BUG-HIGH-03). "Parameterized tests for passwords scoring 2 (rejected) and 3 (accepted)."
- S4 (BUG-HIGH-04). "E2E and use-case integration tests verifying that submitting a password containing the username returns `400 Bad Request` with field error `password: Password is too weak`."
- S5 (BUG-MEDIUM-05). "E2E test verifying sign-in with an unknown username, measuring timing parity against wrong password for existing user."
- S6 (BUG-MEDIUM-06). "Negative integration tests injecting synthetic PostgreSQL errors to ensure unhandled codes bubble up as `500 Internal Server Error`."
- S7 (BUG-MEDIUM-07). "An integration test verifying table creation on an isolated temporary database schema."
- S8 (BUG-LOW-08). "Enforce strict `application/json` header, rejecting simple requests (`text/plain`, `application/x-www-form-urlencoded`) to prevent CORS preflight bypass."
- S9 (BUG-LOW-09). "Define explicit length constraints (e.g. `raw.length < 3 || raw.length > 64`)."

Assumptions: S8 answers 415 "Unsupported Media Type" in the shared error format and accepts `application/json` with parameters (`; charset=utf-8`). S9 adds upper bounds only (the DoS is about size): name at most 64 characters (the report's example; 32 would reject the 35-character names the e2e suites generate), password at most 256 (zxcvbn-ts only scores the first 256 characters, `maxLength`). A minimum of 3 for names would be a new product rule, not part of the bug.

## Tasks

| ID  | Specs | Route  | Test file                                                            | Status                                                         |
| --- | ----- | ------ | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| T1  | S1    | inline | test/integration/user.sign-up.concurrency.integration.test.ts        | done: RED 4/5 calls rejected -> fixed use case + fake          |
| T2  | S2    | inline | test/e2e/user.single-field-validation.e2e.test.ts                    | done: gap, GREEN; mutant `&&` killed (9)                       |
| T3  | S3    | inline | src/backend/user/domain/user.password-boundary.test.ts               | done: gap, GREEN; mutants `<=`,`<2` killed                     |
| T4  | S4    | inline | test/e2e/user.password-contains-name.e2e.test.ts                     | done: gap, GREEN; mutants killed; fixed false-positive VO test |
| T5  | S5    | inline | test/e2e/user.sign-in-timing.e2e.test.ts                             | done: gap, GREEN x3; dummy-verify mutant killed                |
| T6  | S6    | inline | test/integration/user.datasource.fault-injection.integration.test.ts | done: gap, GREEN; masking mutants killed (4)                   |
| T7  | S7    | inline | test/integration/user.schema.integration.test.ts                     | done: gap, GREEN; empty-schema mutant killed                   |
| T8  | S8    | inline | test/e2e/user.content-type.e2e.test.ts                               | done: RED 9 fails (text/plain created users) -> 415            |
| T9  | S9    | inline | test/e2e/user.input-length.e2e.test.ts                               | done: RED 4 fails -> max 64/256                                |

Gap-only bugs (code already correct) prove strength by mutation: apply the report's mutant in a scratch copy, the new test must fail, then restore.

## Log

- L1 (2026-11-12): "Ahora necesito que revises todos los bugs encontrados y documentados en @bugs/, sigue el protocolo ODD(RED->GREEN), endureciendo los archivos de testing, por cada brecha y bug documentado, crea un archivo de testing que pruebe el comportamiento real observable. Si al escribir el test estricto descubres el bug real, corrigelo solamente en el codigo fuente cuando el test en RED, hasta lograr GREEN."
- L2: Pre-check findings: existing test "rejects a password built from the user name" is a false positive ('wonderland1985' scores 2 even without user inputs); zxcvbn-ts truncates to 256 chars, so S9's CPU claim does not apply to zxcvbn; the real exposure is unbounded names stored in DB and JWT.
- L3: Real bugs fixed in source after RED: BUG-01 (SignUpUseCase maps a create() ConflictError to err; other errors still throw), BUG-08 (controller answers 415 unless the media type is application/json), BUG-09 (MAX_NAME_LENGTH 64, MAX_PASSWORD_LENGTH 256, checked before the regex and zxcvbn). The other six were coverage gaps; each new test was proven against the report's mutant in a scratch copy.
- L4: Verified: `bun run verify` green (fmt, lint 0 problems in 43 files, tsc, 46 unit); integration 11/11; e2e 44/44; all 10 mutants killed on the final code; DB left without test rows. Not done: work-unit commits (prior auth work is still uncommitted on feat/users).
- L5 (2026-11-12): "Revisa desde ## 4. Re-Execution & Post-Hardening Sabotage Verification (Run 2)". One survivor at user.controller.ts:42 (`typeof body !== 'object'` -> `false`). Coverage gap, not a source bug: a JSON primitive still ends in 400, but through field validation after the use case runs. New file src/backend/user/presentation/user.controller.json-primitive.test.ts (12 cases: 42, -1.5, true, false, "quoted", "" on both routes) pins the exact message, the absence of `errors`, and that the use case is not called. GREEN on real code; against the mutant the old suite passes 9/9, the new file fails 12/12.
