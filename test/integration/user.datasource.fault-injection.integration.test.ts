import { type ReservedSQL, SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { ConflictError } from '../../src/backend/shared/domain/app.error.ts';
import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { SignInUseCase } from '../../src/backend/user/application/user.sign-in.use-case.ts';
import { SignUpUseCase } from '../../src/backend/user/application/user.sign-up.use-case.ts';
import { PasswordHash, UserName } from '../../src/backend/user/domain/user.value-objects.ts';
import { PostgresUserDatasource } from '../../src/backend/user/infrastructure/user.datasource.postgresql.ts';
import { UserRepositoryImpl } from '../../src/backend/user/infrastructure/user.repository.impl.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import { createAuthController } from '../../src/backend/user/presentation/user.controller.ts';
import { STRONG_PASSWORD } from '../support/auth-server.test-support.ts';

// BUG-MEDIUM-06: only the unique violation (23505) may become ConflictError. Any other database
// failure must keep propagating so the controller answers 500 instead of a misleading 409.

const CHECK_VIOLATION = '23514';
const UNDEFINED_TABLE = '42P01';
const url = loadConfig().databaseUrl;
const sql = createPostgresClient({ max: 2, url });
const emptySchema = `fault_${crypto.randomUUID().replaceAll('-', '')}`;
let withoutTable: ReservedSQL;
const rejectingSchema = `reject_${crypto.randomUUID().replaceAll('-', '')}`;
let rejectingInserts: ReservedSQL;

const newUser = {
  name: UserName.restore(`fault${crypto.randomUUID().replaceAll('-', '')}`),
  passwordHash: PasswordHash.restore('hash'),
};

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA "${emptySchema}"`);
  // A connection whose search_path has no users table: every query fails with a real 42P01.
  withoutTable = await sql.reserve();
  await withoutTable.unsafe(`SET search_path TO "${emptySchema}"`);

  // A users table that can be read but rejects every insert with a real 23514, so the failure
  // happens inside create(), after the findByName pre-check succeeded.
  await sql.unsafe(`CREATE SCHEMA "${rejectingSchema}"`);
  await sql.unsafe(
    `CREATE TABLE "${rejectingSchema}".users (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE CHECK (false),
      password TEXT NOT NULL
    )`,
  );
  rejectingInserts = await sql.reserve();
  await rejectingInserts.unsafe(`SET search_path TO "${rejectingSchema}"`);
});

afterAll(async () => {
  await withoutTable.release();
  await rejectingInserts.release();
  await sql.unsafe(`DROP SCHEMA "${emptySchema}" CASCADE`);
  await sql.unsafe(`DROP SCHEMA "${rejectingSchema}" CASCADE`);
  await sql.close();
});

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the operation to fail');
    },
    (error: unknown) => error,
  );
}

describe('PostgresUserDatasource.create with database failures other than a unique violation', () => {
  test('propagates a real non-unique PostgresError unchanged', async () => {
    const error = await failureOf(new PostgresUserDatasource(withoutTable).create(newUser));

    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(error instanceof SQL.PostgresError ? error.errno : undefined).toBe(UNDEFINED_TABLE);
  });

  test('propagates a real constraint violation that is not the unique one', async () => {
    const error = await failureOf(new PostgresUserDatasource(rejectingInserts).create(newUser));

    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error instanceof SQL.PostgresError ? error.errno : undefined).toBe(CHECK_VIOLATION);
  });

  test('propagates a closed-connection error unchanged', async () => {
    const closed = createPostgresClient({ max: 1, url });
    await closed.close();

    const error = await failureOf(new PostgresUserDatasource(closed).create(newUser));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConflictError);
  });
});

describe('POST /api/auth/sign-up when the database fails', () => {
  test('answers 500, not 409, when the insert fails for a reason other than a taken name', async () => {
    const logged: unknown[] = [];
    const users = new UserRepositoryImpl(new PostgresUserDatasource(rejectingInserts));
    const hasher = new Argon2PasswordHasher();
    const tokens = new JoseTokenIssuer('fault-secret');
    const server = createServer({
      auth: createAuthController(
        { signIn: new SignInUseCase(users, hasher, tokens), signUp: new SignUpUseCase(users, hasher, tokens) },
        { error: (error) => logged.push(error) },
      ),
      port: 0,
    });

    try {
      const response = await fetch(new URL('/api/auth/sign-up', server.url), {
        body: JSON.stringify({ name: newUser.name.value, password: STRONG_PASSWORD }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        correlationId: expect.any(String),
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
        path: '/api/auth/sign-up',
        statusCode: 500,
        timestamp: expect.any(String),
      });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toBeInstanceOf(SQL.PostgresError);
    } finally {
      await server.stop(true);
    }
  });
});
