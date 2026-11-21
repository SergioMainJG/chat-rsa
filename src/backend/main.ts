import { RedisClient } from 'bun';

import type { Logger } from './shared/domain/logger.ts';

import { composeApp } from './app.composition.ts';
import { loadConfig } from './shared/config/env.config.ts';
import { createPostgresClient } from './shared/database/postgres.config.ts';
import { createServer } from './shared/http/app.server.ts';
import { buildPages } from './shared/http/static-pages.ts';
import { installShutdown } from './shared/lifecycle/lifecycle.shutdown.ts';
import { applyUserSchema } from './user/infrastructure/user.schema.ts';
import { Argon2PasswordHasher } from './user/infrastructure/user.security.argon2.ts';
import { JoseTokenIssuer } from './user/infrastructure/user.security.jose.ts';

const config = loadConfig();
const sql = createPostgresClient({ url: config.databaseUrl });
await applyUserSchema(sql);
const cache = new RedisClient(config.cacheUrl);

const logger: Logger = {
  error: (error) => {
    console.error(error);
  },
};

const { auth, messaging } = composeApp({
  cache,
  config,
  hasher: new Argon2PasswordHasher(),
  logger,
  sql,
  tokens: new JoseTokenIssuer(config.jwtSecret),
});

const development = Bun.env.NODE_ENV !== 'production';
const server = createServer({
  auth,
  development,
  messaging,
  // Production bundles the pages once so they carry security headers and are precompressed;
  // development serves the HTML imports with hot reload.
  // The first allowed origin is the public one: canonical and hreflang URLs point at it.
  ...(development
    ? {}
    : { pages: await buildPages(config.appOrigins[0] ?? `http://localhost:${config.port}`) }),
  port: config.port,
});

// SIGTERM: stop new sockets and wait for in-flight messages to be persisted, close every socket
// with 1001, then stop HTTP and release the pools.
installShutdown({
  // Once the server and pools are closed nothing keeps the event loop alive, so the process
  // ends on its own with this code.
  exit: (code) => {
    process.exitCode = code;
  },
  logger,
  signal: 'SIGTERM',
  steps: [
    { name: 'gateway.drain', run: async () => messaging.gateway.drain() },
    { name: 'server.stop', run: async () => server.stop() },
    { name: 'sql.close', run: async () => sql.close() },
    {
      name: 'cache.close',
      run: () => {
        cache.close();
      },
    },
  ],
});

console.info(`chat-rsa listening on ${server.url}`);
