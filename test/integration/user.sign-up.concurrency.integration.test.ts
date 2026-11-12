import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { ConflictError } from '../../src/backend/shared/domain/app.error.ts';
import { SignUpUseCase } from '../../src/backend/user/application/user.sign-up.use-case.ts';
import { PostgresUserDatasource } from '../../src/backend/user/infrastructure/user.datasource.postgresql.ts';
import { UserRepositoryImpl } from '../../src/backend/user/infrastructure/user.repository.impl.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import { STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-CRITICAL-01: concurrent sign-ups with the same name all pass the findByName pre-check,
// so the losers hit the unique constraint inside create(). The use case must still honour its
// Result contract instead of rejecting.

const CONCURRENT_REQUESTS = 5;
const sql = createPostgresClient({ max: CONCURRENT_REQUESTS, url: loadConfig().databaseUrl });
const signUp = new SignUpUseCase(
  new UserRepositoryImpl(new PostgresUserDatasource(sql)),
  new Argon2PasswordHasher(),
  new JoseTokenIssuer('race-secret'),
);
const name = `race${crypto.randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  await applyUserSchema(sql);
});

afterAll(async () => {
  await sql`DELETE FROM users WHERE name = ${name}`;
  await sql.close();
});

describe('SignUpUseCase under concurrent sign-ups for the same name', () => {
  test('every call resolves to a Result: one ok, the rest ConflictError, one stored row', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUESTS }, async () => signUp.execute({ name, password: STRONG_PASSWORD })),
    );

    const rejected = settled.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toEqual([]);

    const results = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const winners = results.filter((result) => result.ok);
    const losers = results.flatMap((result) => (result.ok ? [] : [result.error]));

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CONCURRENT_REQUESTS - 1);
    for (const error of losers) {
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.message).toBe('User already exists');
    }

    const [row] = await sql`SELECT count(*)::int AS count FROM users WHERE name = ${name}`;
    expect(row.count).toBe(1);
  });
});
