import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { jwtVerify } from 'jose';

import type { AuthResponse } from '../../src/shared/contracts/auth.contract.ts';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { SignInUseCase } from '../../src/backend/user/application/user.sign-in.use-case.ts';
import { SignUpUseCase } from '../../src/backend/user/application/user.sign-up.use-case.ts';
import { PostgresUserDatasource } from '../../src/backend/user/infrastructure/user.datasource.postgresql.ts';
import { UserRepositoryImpl } from '../../src/backend/user/infrastructure/user.repository.impl.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from '../../src/backend/user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import { createAuthController } from '../../src/backend/user/presentation/user.controller.ts';

const SECRET = 'e2e-secret';
const config = loadConfig();
const sql = createPostgresClient({ max: 2, url: config.databaseUrl });
const users = new UserRepositoryImpl(new PostgresUserDatasource(sql));
const hasher = new Argon2PasswordHasher();
const tokens = new JoseTokenIssuer(SECRET);
const server = createServer({
  auth: createAuthController(
    {
      signIn: new SignInUseCase(users, hasher, tokens),
      signUp: new SignUpUseCase(users, hasher, tokens),
    },
    {
      error: (error) => {
        console.error(error);
      },
    },
  ),
  port: 0,
});

const name = `e2e${crypto.randomUUID().replaceAll('-', '')}`;
const password = 'correct-Horse-battery-st4ple';

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, server.url), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

beforeAll(async () => {
  await applyUserSchema(sql);
});

afterAll(async () => {
  await server.stop(true);
  await sql`DELETE FROM users WHERE name = ${name}`;
  await sql.close();
});

describe('application over HTTP', () => {
  test('GET / serves the frontend', async () => {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>chat-rsa</title>');
  });

  test('unknown routes return 404 in the shared error format', async () => {
    const response = await fetch(new URL('/nope', server.url));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      correlationId: expect.any(String),
      error: 'Not Found',
      message: 'Route GET /nope not found',
      path: '/nope',
      statusCode: 404,
      timestamp: expect.any(String),
    });
  });

  test('a known route with an unsupported method returns 404 in the shared error format', async () => {
    const response = await fetch(new URL('/api/auth/sign-in', server.url));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Not Found',
      message: 'Route GET /api/auth/sign-in not found',
      path: '/api/auth/sign-in',
      statusCode: 404,
    });
  });
});

describe('auth over HTTP', () => {
  test('POST /api/auth/sign-up creates the user and returns {user, token}', async () => {
    const response = await post('/api/auth/sign-up', { name, password });
    const body: AuthResponse = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ token: expect.any(String), user: { id: expect.any(Number), name } });
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(SECRET));
    expect(payload.sub).toBe(String(body.user.id));

    const [row] = await sql`SELECT password FROM users WHERE name = ${name}`;
    expect(row.password).toStartWith('$argon2id$');
  });

  test('POST /api/auth/sign-up rejects a taken name with 409', async () => {
    const response = await post('/api/auth/sign-up', { name, password });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      correlationId: expect.any(String),
      error: 'Conflict',
      message: 'User already exists',
      path: '/api/auth/sign-up',
      statusCode: 409,
      timestamp: expect.any(String),
    });
  });

  test('POST /api/auth/sign-in returns {user, token} for valid credentials', async () => {
    const response = await post('/api/auth/sign-in', { name, password });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: expect.any(String), user: { id: expect.any(Number), name } });
  });

  test('POST /api/auth/sign-in rejects a wrong password with 401', async () => {
    const response = await post('/api/auth/sign-in', { name, password: 'another-Strong-pass-99' });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Unauthorized', message: 'Invalid credentials' });
  });

  test('POST /api/auth/sign-in reports an invalid name but never judges password strength', async () => {
    const response = await post('/api/auth/sign-in', { name: 'has space', password: 'password' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      correlationId: expect.any(String),
      error: 'Bad Request',
      errors: [{ field: 'name', message: 'Name must contain only letters and numbers, without spaces' }],
      message: 'Validation failed',
      path: '/api/auth/sign-in',
      statusCode: 400,
      timestamp: expect.any(String),
    });
  });
});
