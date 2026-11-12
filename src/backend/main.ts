import type { Logger } from './shared/domain/logger.ts';

import { loadConfig } from './shared/config/env.config.ts';
import { createPostgresClient } from './shared/database/postgres.config.ts';
import { createServer } from './shared/http/app.server.ts';
import { SignInUseCase } from './user/application/user.sign-in.use-case.ts';
import { SignUpUseCase } from './user/application/user.sign-up.use-case.ts';
import { PostgresUserDatasource } from './user/infrastructure/user.datasource.postgresql.ts';
import { UserRepositoryImpl } from './user/infrastructure/user.repository.impl.ts';
import { applyUserSchema } from './user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from './user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from './user/infrastructure/user.security.jose.ts';
import { createAuthController } from './user/presentation/user.controller.ts';

const config = loadConfig();
const sql = createPostgresClient({ url: config.databaseUrl });
await applyUserSchema(sql);

const users = new UserRepositoryImpl(new PostgresUserDatasource(sql));
const hasher = new Argon2PasswordHasher();
const tokens = new JoseTokenIssuer(config.jwtSecret);
const logger: Logger = {
  error: (error) => {
    console.error(error);
  },
};

const server = createServer({
  auth: createAuthController(
    {
      signIn: new SignInUseCase(users, hasher, tokens),
      signUp: new SignUpUseCase(users, hasher, tokens),
    },
    logger,
  ),
  development: Bun.env.NODE_ENV !== 'production',
  port: config.port,
});

console.info(`chat-rsa listening on ${server.url}`);
