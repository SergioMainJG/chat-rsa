import { expect, test } from 'bun:test';

import { loadConfig } from './env.config.ts';

test('loadConfig falls back to local defaults', () => {
  expect(loadConfig({})).toEqual({
    cacheUrl: 'redis://localhost:6380',
    databaseUrl: 'postgres://chat:chat@localhost:5433/chat',
    jwtSecret: 'dev-only-jwt-secret-change-me',
    port: 3000,
  });
});

test('loadConfig reads values from the environment', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://u:p@db:5432/x',
    JWT_SECRET: 'secret',
    PORT: '8080',
    VALKEY_URL: 'redis://cache:6379',
  });
  expect(config).toEqual({
    cacheUrl: 'redis://cache:6379',
    databaseUrl: 'postgres://u:p@db:5432/x',
    jwtSecret: 'secret',
    port: 8080,
  });
});

test('loadConfig refuses the development JWT secret in production', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('JWT_SECRET must be set in production');
});
