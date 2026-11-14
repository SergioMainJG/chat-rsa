import { expect, test } from 'bun:test';

import { loadConfig } from './env.config.ts';

test('loadConfig falls back to local defaults', () => {
  expect(loadConfig({})).toEqual({
    cacheUrl: 'redis://localhost:6380',
    databaseUrl: 'postgres://chat:chat@localhost:5433/chat',
    jwtSecret: 'dev-only-jwt-secret-change-me',
    port: 3000,
    rateLimit: { ip: { capacity: 120, refillPerSecond: 20 }, user: { capacity: 60, refillPerSecond: 10 } },
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
    rateLimit: { ip: { capacity: 120, refillPerSecond: 20 }, user: { capacity: 60, refillPerSecond: 10 } },
  });
});

test('loadConfig refuses the development JWT secret in production', () => {
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('JWT_SECRET must be set in production');
});

test('loadConfig reads the rate limit policies from the environment', () => {
  const config = loadConfig({
    RATE_LIMIT_IP_CAPACITY: '30',
    RATE_LIMIT_IP_REFILL: '2.5',
    RATE_LIMIT_USER_CAPACITY: '15',
    RATE_LIMIT_USER_REFILL: '0.5',
  });
  expect(config.rateLimit).toEqual({
    ip: { capacity: 30, refillPerSecond: 2.5 },
    user: { capacity: 15, refillPerSecond: 0.5 },
  });
});

test.each([['0'], ['-1'], ['abc'], ['']])('loadConfig refuses the rate limit value %p', (raw) => {
  expect(() => loadConfig({ RATE_LIMIT_USER_REFILL: raw })).toThrow('RATE_LIMIT_USER_REFILL must be a positive number');
});
