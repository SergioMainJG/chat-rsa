# user-auth

Objective: user feature with Postgres persistence and `/api/auth/sign-in` + `/api/auth/sign-up`.
Branch: none yet (repository has no commits; work-unit commits deferred to the user). Delivery: ask-on-risk. Test runner: `bun test`.

## Specs

- S1. Users table "debe lucir como en @sql/index.sql": `id` integer PK auto-generated, `name TEXT NOT NULL UNIQUE`, `password TEXT NOT NULL` (translated from SQLite `AUTOINCREMENT` to Postgres identity).
- S2. "archivo de configuration de bun para la conexion y modelado para integrarlo al pod de postgres".
- S3. "entity reforzado con value object y branded type".
- S4. "usar repository y datasource pattern para que el datasource (user.datasource.postgresql.ts) sea quien se comunique con la bd mediante una clase abstracta (user.datasource.ts), y el repository siga algo similar con user.repository.ts y la implementacion sea user.repository.impl.ts para aplicar DI con los datasources."
- S5. "las rutas deben ser api/auth/sign-in api/auth/sign-up, con lo que los controladores deben manejar 2 errores: errores que extiendan de la clase Error y Result Pattern"
- S6. "sign-in recibe el nombre y la contraseña, debes validar que el nombre use letras, numeros, y no espacios. La contraseña que siga el patron de @zxcvbn-ts/core."
- S7. Success body: "{user: {id, name}, token}".
- S8. Error body: "{correlationId, error, errors[{field, message}],message, path, statusCode, timestamp} o {correlationId, error, message, path, statusCode, timestamp}".

Assumptions (not stated by the user): zxcvbn score >= 3 passes; sign-up validates the same way and returns S7 with 201; token is an HS256 JWT (jose, 1h, `JWT_SECRET`); unknown name and wrong password both return 401 "Invalid credentials".

## Tasks

- [x] T1 (S1, S2) inline: Postgres SQL, connection config, schema apply, pod init mount.
- [x] T2 (S3, S4) inline: branded types, value objects, entity, abstract datasource/repository, Postgres datasource, repository impl.
- [x] T3 (S5-S8) inline: Result, AppError hierarchy, use cases, controller, error response, routes, composition root.
- [x] T4 inline: unit, integration and e2e tests.

## Log

- L1 (2026-11-12): "Ahora necesito que para la bd, el usuario debe lucir como en @sql/index.sql. Tienes que crear para el feature de usuario: - archivo de configuration de bun para la conexion y modelado para integrarlo al pod de postgres - entity reforzado con value object y branded type - usar repository y datasource pattern para que el datasource (user.datasource.postgresql.ts) sea quien se comunique con la bd mediante una clase abstracta (user.datasource.ts), y el repository siga algo similar con user.repository.ts y la implementacion sea user.repository.impl.ts para aplicar DI con los datasources. - las rutas deben ser api/auth/sign-in api/auth/sign-up, con lo que los controladores deben manejar 2 errores: errores que extiendan de la clase Error y Result Pattern"
- L2 (2026-11-12): "sign-in recibe el nombre y la contraseña, debes validar que el nombre use letras, numeros, y no espacios. La contraseña que siga el patron de @zxcvbn-ts/core. La respuesta debe ser {user: {id, name}, token}, si no, se retorna, tenga {correlationId, error, errors[{field, message}],message, path, statusCode, timestamp} o {correlationId, error, message, path, statusCode, timestamp}"
- L4: Verified: tsc OK; `bun test ./src ./test` 48 pass / 0 fail against the pod's Postgres; `bun build` inlines sql/index.sql; smoke run of main.ts on PORT=3999 returned S7 and S8 bodies. Not run: `bun fmt --check`, `bun lint` (L3). RED was not observed before implementation (tests written after code). Kept the global 404 body unchanged (not requested). Recreated the stale `chat-rsa` pod (old 3000/5432/6379 bindings, never started).
- L5 (2026-11-12): "Si, todos los errores ddeben usar el nuevo formato de error. Actualiza el @.env.example para tener todas las variables env nuevas". S8 now covers every error: the 404 fallback uses `NotFoundError` + `errorResponse` (RED observed: 2 e2e fails, then GREEN 49/49). `.env.example` and `.env` are blocked by a permission deny rule; content handed to the user to paste. The user's new `.env` points DATABASE_URL at host port 5432 (not the pod's 5433), so tests were run with DATABASE_URL overridden.
- L3: bunfig.toml is truncated (user's in-progress edit), so fmt/lint cannot run; tests run with an empty scratch bunfig.
