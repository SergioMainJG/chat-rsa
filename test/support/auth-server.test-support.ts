import type { SQL } from 'bun';

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

export const STRONG_PASSWORD = 'correct-Horse-battery-st4ple';

export type AuthServer = {
  /** Removes the users this server created and releases the port and the pool. */
  readonly close: () => Promise<void>;
  /** A unique, valid user name; remembered so `close` can delete it. */
  readonly freshName: (prefix?: string) => string;
  /** Errors the controller reported as unexpected (500). */
  readonly logged: unknown[];
  /** `contentType: null` sends no Content-Type header; strings and Blobs are sent as-is. */
  readonly post: (path: string, body: unknown, contentType?: null | string) => Promise<Response>;
  readonly sql: SQL;
};

/** Boots the real HTTP server wired to the pod's Postgres and real argon2/jose adapters. */
export async function startAuthServer(): Promise<AuthServer> {
  const sql = createPostgresClient({ max: 4, url: loadConfig().databaseUrl });
  await applyUserSchema(sql);

  const users = new UserRepositoryImpl(new PostgresUserDatasource(sql));
  const hasher = new Argon2PasswordHasher();
  const tokens = new JoseTokenIssuer('e2e-secret');
  const logged: unknown[] = [];
  const created: string[] = [];

  const server = createServer({
    auth: createAuthController(
      {
        signIn: new SignInUseCase(users, hasher, tokens),
        signUp: new SignUpUseCase(users, hasher, tokens),
      },
      {
        error: (error) => {
          logged.push(error);
        },
      },
    ),
    port: 0,
  });

  return {
    close: async () => {
      await server.stop(true);
      if (created.length > 0) {
        await sql`DELETE FROM users WHERE name IN ${sql(created)}`;
      }
      await sql.close();
    },
    freshName: (prefix = 'e2e') => {
      const name = `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
      created.push(name);
      return name;
    },
    logged,
    post: async (path, body, contentType = 'application/json') =>
      fetch(new URL(path, server.url), {
        body: typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body),
        headers: contentType === null ? {} : { 'content-type': contentType },
        method: 'POST',
      }),
    sql,
  };
}
